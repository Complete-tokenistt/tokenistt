import type { Tokenistt } from '../client';

/** Base class for all API resources (mirrors `openai`'s `APIResource`). */
export abstract class APIResource {
  constructor(protected client: Tokenistt) {}
}
