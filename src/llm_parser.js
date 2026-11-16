// Optional LLM interpreter (IMPLEMENTED, off unless the server has credentials).
//
// The browser never holds an API key: it asks the local server (server.py), which calls the
// Claude API with the reviewer's own key. If the server says the model is unavailable, this
// returns null and the prototype runs on the rule parser alone.
//
// The returned function resolves to a *proposal* { tool, args, confidence, alternatives } or
// null. The dialogue manager validates it arg by arg before anything runs (L12).

export async function makeLlmParser() {
  try {
    const res = await fetch('/api/llm/status');
    if (!res.ok) return null;
    const status = await res.json();
    if (!status.enabled) return null;
    const fn = async (text, context) => {
      const r = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context }),
      });
      if (!r.ok) throw new Error('server ' + r.status);
      const data = await r.json();
      return data.proposal ?? null;
    };
    fn.model = status.model;
    return fn;
  } catch {
    return null; // static hosting or server without the endpoint
  }
}
