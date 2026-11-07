// A user cache in front of a slow lookup.
export let fetchCalls = 0;
const cache = new Map();

export async function fakeFetch(id) {
  fetchCalls++;
  await new Promise((r) => setTimeout(r, Math.random() * 10));
  return { id, name: `user ${id}` };
}

export async function getUser(id) {
  if (cache.has(id)) return cache.get(id);
  const user = await fakeFetch(id);
  cache.set(id, user);
  return user;
}

export function reset() {
  cache.clear();
  fetchCalls = 0;
}
