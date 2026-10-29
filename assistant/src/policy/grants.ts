import { sha256 } from '../hash.ts';

export type EffectRequest = {
  version: 1; operationId: string; profileId: string; sessionId: string; taskId: string; runId: string;
  adapter: string; action: string; account: string; destination: string; policyVersion: string;
  expiresAt: number; payload: Uint8Array;
};
export type EffectMetadata = Omit<EffectRequest, 'payload'>;

const fields = ['operationId', 'profileId', 'sessionId', 'taskId', 'runId', 'adapter', 'action', 'account', 'destination', 'policyVersion'] as const;
export function snapshot(request: EffectRequest, profileId: string, now: number) {
  let metadata: EffectMetadata;
  let payload: Buffer;
  try {
    if (!request || (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)) throw new Error('invalid_request');
    const descriptors = Object.getOwnPropertyDescriptors(request);
    const value = (field: keyof EffectRequest) => {
      const descriptor = descriptors[field];
      if (!descriptor || !('value' in descriptor)) throw new Error('invalid_request');
      return descriptor.value;
    };
    const captured = Object.fromEntries(fields.map(field => [field, value(field)])) as Pick<EffectMetadata, typeof fields[number]>;
    const version = value('version');
    const expiresAt = value('expiresAt');
    const inputPayload = value('payload');
    if (version !== 1 || !(inputPayload instanceof Uint8Array)) throw new Error('invalid_request');
    for (const field of fields) {
      const text = captured[field];
      if (typeof text !== 'string' || !text.isWellFormed() || text.length > 1024 || text.trim() !== text || !text || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error('invalid_request');
    }
    if (captured.profileId !== profileId || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('invalid_request');
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!.call(inputPayload);
    const offset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!.call(inputPayload);
    const length = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!.call(inputPayload);
    if (length > 1024 * 1024) throw new Error('invalid_request');
    payload = Buffer.from(new Uint8Array(buffer, offset, length));
    metadata = { version: 1, ...captured, expiresAt };
  } catch {
    throw new Error('invalid_request');
  }
  const payloadHash = sha256(payload);
  const { operationId, ...scope } = metadata;
  return { metadata, payload, binding: sha256(JSON.stringify([scope, payloadHash])), operation: sha256(JSON.stringify([profileId, operationId])) };
}
