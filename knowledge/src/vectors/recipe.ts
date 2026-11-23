// What a vector is a vector of: how a chunk's text is put to the embedding model, how a question is, and how a
// vector is carried. One copy, used by the embedding stage, the index build, the service and the gate.

// The text a chunk is embedded from: its context line, a newline, then its text; the text alone when it has no
// context. Documents get no instruction. The name changes whenever the recipe does.
export const DOCUMENT_RECIPE = 'context-newline-text/1';

// The instruction a question is embedded with, as the embedding model's card asks for queries.
export const QUERY_INSTRUCTION = 'Given a question about a medicine, retrieve passages of its label that answer the question';

export function documentText(chunk: { text: string; context?: string | null }): string {
  const context = typeof chunk.context === 'string' ? chunk.context : '';
  return context === '' ? chunk.text : `${context}\n${chunk.text}`;
}

export function queryText(query: string): string {
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`;
}

// A vector as the embedding server returns it for encoding_format base64: little-endian float32. Null when the
// bytes are not a whole number of float32 values; each caller treats that as it treats a vector of the wrong length.
export function decodeVector(base64: string): Float32Array | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(bytes.length / 4);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
  return values;
}

export function encodeVector(values: readonly number[] | Float32Array): string {
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i] ?? 0, i * 4);
  return bytes.toString('base64');
}

// What identifies the vectors an index holds, recorded in the index's _meta and compared by the service before it
// uses a vector.
export type EmbeddingIdentity = {
  repository: string;
  revision: string;
  dimensions: number;
  recipe: string;
  instruction: string;
  vectorsSha256: string;
};

// The parts of an identity that the service can know from its own configuration and constants. The vectors' hash
// is the index's own; it is recorded so a reader can tell which vector files an index holds.
export type ConfiguredIdentity = { repository: string; revision: string; dimensions: number };

// The fields of a recorded identity that differ from what is configured; none when it matches.
export function identityDifferences(recorded: EmbeddingIdentity, configured: ConfiguredIdentity): string[] {
  const differences: string[] = [];
  if (recorded.repository !== configured.repository) differences.push('repository');
  if (recorded.revision !== configured.revision) differences.push('revision');
  if (recorded.dimensions !== configured.dimensions) differences.push('dimensions');
  if (recorded.recipe !== DOCUMENT_RECIPE) differences.push('recipe');
  if (recorded.instruction !== QUERY_INSTRUCTION) differences.push('instruction');
  return differences;
}
