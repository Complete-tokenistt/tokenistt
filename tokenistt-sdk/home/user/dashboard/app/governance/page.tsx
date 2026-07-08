"use client";

import { useEffect, useState } from "react";
import type { Policy } from "@/lib/types";
import Section from "@/components/Section";

export default function GovernancePage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [costLimit, setCostLimit] = useState("");
  const [promptKeyword, setPromptKeyword] = useState("");
  
  const [effect, setEffect] = useState<"block" | "require_approval" | "force_model">("block");
  const [redirectModel, setRedirectModel] = useState("");
  const [customMessage, setCustomMessage] = useState("");

  const [saving, setSaving] = useState(false);

  // Fetch policies on load
  useEffect(() => {
    fetchPolicies();
  }, []);

  async function fetchPolicies() {
    try {
      setLoading(true);
      const res = await fetch("/api/policies");
      if (!res.ok) throw new Error("Failed to fetch policies");
      const data = await res.json();
      setPolicies(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function togglePolicy(policy: Policy) {
    const updatedStatus = !policy.is_enabled;
    
    // Optimistic Update
    setPolicies(prev =>
      prev.map(p => (p.public_id === policy.public_id ? { ...p, is_enabled: updatedStatus } : p))
    );

    try {
      const res = await fetch("/api/policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_id: policy.public_id,
          is_enabled: updatedStatus
        })
      });
      if (!res.ok) throw new Error("Failed to update policy status");
    } catch (err: any) {
      // Revert state
      setPolicies(prev =>
        prev.map(p => (p.public_id === policy.public_id ? { ...p, is_enabled: policy.is_enabled } : p))
      );
      alert("Error: " + err.message);
    }
  }

  async function deletePolicy(publicId: string) {
    if (!confirm("Are you sure you want to delete this policy?")) return;

    // Optimistic Update
    const original = [...policies];
    setPolicies(prev => prev.filter(p => p.public_id !== publicId));

    try {
      const res = await fetch(`/api/policies?public_id=${publicId}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("Failed to delete policy");
    } catch (err: any) {
      setPolicies(original);
      alert("Error: " + err.message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;

    try {
      setSaving(true);
      const conditions: any = {};
      if (costCenter) conditions.cost_center = costCenter;
      if (targetModel) conditions.model = targetModel;
      if (costLimit) conditions.cost_limit = parseFloat(costLimit);
      if (promptKeyword) conditions.prompt_keyword = promptKeyword;

      const actions: any = { effect };
      if (effect === "force_model") {
        actions.model = redirectModel || "claude-3-haiku";
      }
      if (customMessage) {
        actions.message = customMessage;
      }

      const res = await fetch("/api/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          is_enabled: true,
          conditions,
          actions
        })
      });

      if (!res.ok) throw new Error("Failed to create policy");
      const newPolicy = await res.json();
      
      setPolicies(prev => [newPolicy, ...prev]);
      
      // Reset form
      setName("");
      setDescription("");
      setCostCenter("");
      setTargetModel("");
      setCostLimit("");
      setPromptKeyword("");
      setEffect("block");
      setRedirectModel("");
      setCustomMessage("");
      setShowAddForm(false);
    } catch (err: any) {
      alert("Error creating policy: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Governance & Policies</h2>
          <p className="text-sm text-slate-500">
            Define constraints, force cost-optimized model routing, and control developer spending.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-500 transition-colors"
        >
          <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {showAddForm ? "Cancel" : "Create New Rule"}
        </button>
      </header>

      {/* Policy Builder Drawer/Form */}
      {showAddForm && (
        <form onSubmit={handleSubmit} className="border border-slate-200 bg-white rounded-xl p-6 shadow-sm space-y-6 animate-fadeIn">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Policy Builder</h3>
            <p className="text-xs text-slate-500 mt-0.5">Specify matching criteria (conditions) and the enforcement response (actions).</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Metadata */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">1. General Details</h4>
              <div>
                <label className="block text-xs font-medium text-slate-700">Policy Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g., Block GPT-4 for Interns"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">Description</label>
                <textarea
                  placeholder="Explain the purpose of this rule"
                  rows={2}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                />
              </div>
            </div>

            {/* Conditions */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">2. Match Conditions (Leave blank to match all)</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Cost Center</label>
                  <input
                    type="text"
                    placeholder="e.g., interns"
                    value={costCenter}
                    onChange={e => setCostCenter(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Model Name Contains</label>
                  <input
                    type="text"
                    placeholder="e.g., gpt-4"
                    value={targetModel}
                    onChange={e => setTargetModel(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Pre-flight Cost &gt; (USD)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="e.g., 0.50"
                    value={costLimit}
                    onChange={e => setCostLimit(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Prompt Contains Keyword</label>
                  <input
                    type="text"
                    placeholder="e.g., summarize"
                    value={promptKeyword}
                    onChange={e => setPromptKeyword(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              </div>
            </div>
          </div>

          <hr className="border-slate-100" />

          {/* Action Trigger */}
          <div className="space-y-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">3. Action & Response</h4>
            <div className="grid gap-6 md:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">Enforcement Action</label>
                <select
                  value={effect}
                  onChange={e => setEffect(e.target.value as any)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                >
                  <option value="block">🚫 Block Request</option>
                  <option value="require_approval">⏳ Require Approval</option>
                  <option value="force_model">🔄 Force Model Redirection</option>
                </select>
              </div>

              {effect === "force_model" && (
                <div>
                  <label className="block text-xs font-medium text-slate-700">Redirect Target Model</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., claude-3-haiku"
                    value={redirectModel}
                    onChange={e => setRedirectModel(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              )}

              {(effect === "block" || effect === "require_approval") && (
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700">Custom Rejection Message</label>
                  <input
                    type="text"
                    placeholder="Provide a helpful message explaining the rejection reason to the developer"
                    value={customMessage}
                    onChange={e => setCustomMessage(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 shadow-sm transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Add Policy Rule"}
            </button>
          </div>
        </form>
      )}

      {/* Rules list */}
      <Section
        title="Active Policies & Constraints"
        description="Policies are evaluated top-to-bottom on every incoming request. The first matching policy triggers immediate action."
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"></div>
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-50 p-4 text-sm text-red-600">{error}</div>
        ) : policies.length === 0 ? (
          <div className="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl bg-white">
            No rules configured. Click "Create New Rule" to get started.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {policies.map(policy => {
              const { conditions, actions } = policy;
              return (
                <div
                  key={policy.public_id}
                  className={`relative flex flex-col justify-between border rounded-xl bg-white p-5 transition-shadow hover:shadow-md ${
                    policy.is_enabled ? "border-slate-200" : "border-slate-200 opacity-60"
                  }`}
                >
                  {/* Top line info */}
                  <div>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="font-semibold text-slate-900">{policy.name}</h4>
                        {policy.description && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{policy.description}</p>
                        )}
                      </div>
                      <div className="flex items-center">
                        <button
                          onClick={() => togglePolicy(policy)}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            policy.is_enabled ? "bg-brand-600" : "bg-slate-200"
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              policy.is_enabled ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {/* Criteria / conditions tags */}
                    <div className="mt-4 space-y-2">
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Criteria:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.keys(conditions).length === 0 ? (
                          <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/10">
                            Matches All Calls
                          </span>
                        ) : (
                          <>
                            {conditions.cost_center && (
                              <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-700/10">
                                Team: {conditions.cost_center}
                              </span>
                            )}
                            {conditions.model && (
                              <span className="inline-flex items-center rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-700/10">
                                Model: {conditions.model}
                              </span>
                            )}
                            {conditions.cost_limit && (
                              <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-700/10">
                                Cost &gt; ${conditions.cost_limit.toFixed(2)}
                              </span>
                            )}
                            {conditions.prompt_keyword && (
                              <span className="inline-flex items-center rounded-md bg-pink-50 px-2 py-1 text-xs font-medium text-pink-700 ring-1 ring-inset ring-pink-700/10">
                                Keyword: "{conditions.prompt_keyword}"
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Enforcement action line */}
                  <div className="mt-6 pt-4 border-t border-slate-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {actions.effect === "block" && (
                        <>
                          <span className="flex h-2 w-2 rounded-full bg-rose-500" />
                          <span className="text-xs font-semibold text-rose-600">🚫 Block Call</span>
                        </>
                      )}
                      {actions.effect === "require_approval" && (
                        <>
                          <span className="flex h-2 w-2 rounded-full bg-amber-500" />
                          <span className="text-xs font-semibold text-amber-600">⏳ Needs Approval</span>
                        </>
                      )}
                      {actions.effect === "force_model" && (
                        <>
                          <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="text-xs font-semibold text-emerald-600">🔄 Route → {actions.model}</span>
                        </>
                      )}
                    </div>
                    
                    <button
                      onClick={() => deletePolicy(policy.public_id)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
                      title="Delete Rule"
                    >
                      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-1.5 12a1.5 1.5 0 01-1.5 1.5H7.5A1.5 1.5 0 016 20.25l-1.5-12m3 0V5.25A2.25 2.25 0 019.75 3h4.5A2.25 2.25 0 0116.5 5.25V8.25m-10.5 0h12" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
