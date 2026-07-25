/**
 * Cloudflare Pages Function.
 *
 * Setup:
 *   1. Bind the same KV namespace used by wvic-data-collector to this
 *      Pages project: Cloudflare dashboard -> your Pages project ->
 *      Settings -> Functions -> KV namespace bindings -> add binding
 *      named "WVIC_DATA" pointing at the same namespace ID.
 *   2. Deploy (git push, or `wrangler pages deploy`).
 *   3. Test: https://yourdomain.com/api/reservoir?dam=rice
 */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const dam = url.searchParams.get("dam");

  if (!dam || !["rice", "willow"].includes(dam)) {
    return new Response(
      JSON.stringify({ error: "Missing or invalid ?dam= parameter (expected 'rice' or 'willow')" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  if (!env.WVIC_DATA) {
    return new Response(
      JSON.stringify({ error: "WVIC_DATA KV binding not configured for this Pages project" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const [readingsJson, lastSynced] = await Promise.all([
    env.WVIC_DATA.get(`readings:${dam}`),
    env.WVIC_DATA.get(`last_synced:${dam}`),
  ]);

  const body = JSON.stringify({
    readings: readingsJson ? JSON.parse(readingsJson) : [],
    last_synced: lastSynced || null,
  });

  return new Response(body, {
    headers: {
      "content-type": "application/json",
      // Short cache since the underlying data changes
      // but keep it brief so a fresh collection shows up quickly.
      "cache-control": "public, max-age=60",
    },
  });
}
