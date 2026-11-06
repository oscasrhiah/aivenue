/**
 * Turn a title into a URL slug: lower case, ASCII letters and digits, words joined by "-".
 * slugify('Hello, World!') === 'hello-world'
 * With { maxLength }, at most that many characters, cut between words when possible.
 */
export function slugify(text, { maxLength } = {}) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!maxLength || slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, maxLength)).replace(/-+$/, '');
}
