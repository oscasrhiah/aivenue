/**
 * Turn a title into a URL slug: lower case, ASCII letters and digits, words joined by "-".
 * slugify('Hello, World!') === 'hello-world'
 */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
