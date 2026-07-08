import { RedisCache } from '../cache/redis.js';
import { 
  AttributionContext, 
  BudgetCheckResult,
  FinOpsConfig 
} from '../types/index.js';
import { VirtualKeyService } from './virtualKey.js';

const BUDGET_PREFIX = 'budget:';
const BUDGET_USED_SUFFIX = 'used';
const BUDGET_WINDOW_SUFFIX = 'window';

export class BudgetService {
  private cache: RedisCache;
  private virtualKeyService: VirtualKeyService;
  private defaultBudgetLimit: number;
  
  constructor(
    cache: RedisCache,
    virtualKeyService: VirtualKeyService,
    defaultBudgetLimit: number = 100.00
  ) {
    this.cache = cache;
    this.virtualKeyService = virtualKeyService;
    this.defaultBudgetLimit = defaultBudgetLimit;
  }
  
  /**
   * Check if a request is within budget
   */
  async checkBudget(
    context: AttributionContext,
    estimatedCost: number
  ): Promise<BudgetCheckResult> {
    const budgetKey = `${BUDGET_PREFIX}${context.virtualKeyId}:${BUDGET_USED_SUFFIX}`;
    
    // Get current usage from cache (this is the delta since last sync)
    const cachedUsage = await this.cache.get<number>(budgetKey);
    const currentUsedFromCache = cachedUsage || 0;
    
    // Calculate actual used (from stored budgetRemaining vs budgetLimit)
    const currentRemaining = context.budgetRemaining;
    const limit = context.budgetLimit;
    const used = limit - currentRemaining;
    
    // Total used = stored used + delta from cache
    const totalUsed = used + currentUsedFromCache;
    const remainingAfter = limit - totalUsed - estimatedCost;
    
    const result: BudgetCheckResult = {
      allowed: remainingAfter >= 0,
      estimatedCost,
      remainingAfter: Math.max(0, remainingAfter),
      currentRemaining: currentRemaining - currentUsedFromCache,
      limit,
      used: totalUsed,
    };
    
    return result;
  }
  
  /**
   * Record a cost against the budget
   * Call this after a successful API request
   */
  async recordCost(
    context: AttributionContext,
    actualCost: number,
    ttlSeconds: number = 3600 // 1 hour default window
  ): Promise<void> {
    const budgetKey = `${BUDGET_PREFIX}${context.virtualKeyId}:${BUDGET_USED_SUFFIX}`;
    
    // Increment the cached usage
    // This tracks the delta since last sync with the main store
    const newUsage = await this.cache.increment(budgetKey, Math.round(actualCost * 1000000) / 1000000);
    
    // Set TTL for the usage key (it'll reset on budget period)
    await this.cache.set(budgetKey, newUsage, ttlSeconds);
  }
  
  /**
   * Reserve budget for a request (optimistic lock)
   * This decrements the available budget
   */
  async reserveBudget(
    context: AttributionContext,
    estimatedCost: number
  ): Promise<boolean> {
    const reserveKey = `${BUDGET_PREFIX}${context.virtualKeyId}:reserve`;
    
    // Get current reservation
    const currentReserve = await this.cache.get<number>(reserveKey) || 0;
    const availableBudget = context.budgetRemaining - currentReserve;
    
    if (availableBudget < estimatedCost) {
      return false; // Not enough budget
    }
    
    // Add to reservation
    await this.cache.set(
      reserveKey, 
      currentReserve + estimatedCost, 
      3600 // 1 hour TTL
    );
    
    return true;
  }
  
  /**
   * Release reserved budget (if request fails or is cancelled)
   */
  async releaseBudget(
    context: AttributionContext,
    estimatedCost: number
  ): Promise<void> {
    const reserveKey = `${BUDGET_PREFIX}${context.virtualKeyId}:reserve`;
    
    const currentReserve = await this.cache.get<number>(reserveKey) || 0;
    const newReserve = Math.max(0, currentReserve - estimatedCost);
    
    await this.cache.set(reserveKey, newReserve, 3600);
  }
  
  /**
   * Get budget status for a virtual key
   */
  async getBudgetStatus(context: AttributionContext): Promise<{
    limit: number;
    used: number;
    remaining: number;
    usedPercentage: number;
  }> {
    const budgetKey = `${BUDGET_PREFIX}${context.virtualKeyId}:${BUDGET_USED_SUFFIX}`;
    const cachedUsage = await this.cache.get<number>(budgetKey) || 0;
    
    const storedUsed = context.budgetLimit - context.budgetRemaining;
    const totalUsed = storedUsed + cachedUsage;
    const remaining = context.budgetLimit - totalUsed;
    
    return {
      limit: context.budgetLimit,
      used: totalUsed,
      remaining: Math.max(0, remaining),
      usedPercentage: (totalUsed / context.budgetLimit) * 100,
    };
  }
  
  /**
   * Sync budget usage to persistent storage
   * Should be called periodically or on shutdown
   */
  async syncBudget(context: AttributionContext): Promise<void> {
    const budgetKey = `${BUDGET_PREFIX}${context.virtualKeyId}:${BUDGET_USED_SUFFIX}`;
    
    // Get current cached usage
    const cachedUsage = await this.cache.get<number>(budgetKey);
    
    if (cachedUsage && cachedUsage > 0) {
      // In a real implementation, this would sync to Postgres/DB
      // For now, we just log
      console.log(`[Budget] Syncing ${cachedUsage} for ${context.virtualKeyId}`);
      
      // Reset cache after sync
      await this.cache.delete(budgetKey);
    }
  }
  
  /**
   * Reset budget for a virtual key
   */
  async resetBudget(context: AttributionContext): Promise<void> {
    const budgetKey = `${BUDGET_PREFIX}${context.virtualKeyId}:${BUDGET_USED_SUFFIX}`;
    const reserveKey = `${BUDGET_PREFIX}${context.virtualKeyId}:reserve`;
    
    await this.cache.delete(budgetKey);
    await this.cache.delete(reserveKey);
    
    // Invalidate the virtual key cache
    await this.virtualKeyService.invalidateCache(context.virtualKeyId);
  }
}
