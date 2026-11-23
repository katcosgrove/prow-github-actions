/**
 * decodeContent turns a contents API body into text. GitHub serves file bodies
 * base64 encoded with newlines inserted every 60 characters, which `atob`
 * rejects, so they are stripped first.
 *
 * @param content - the `content` field
 * @param encoding - the `encoding` field; only `base64` is supported
 */
export function decodeContent(content: string, encoding: string): string {
  if (encoding !== 'base64') {
    throw new Error(`unsupported content encoding ${encoding}`)
  }
  const bytes = Uint8Array.from(atob(content.replace(/\s+/g, '')), char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * encodeContent turns text into the base64 body the contents API takes, as
 * UTF-8, with the web APIs both the Node and the Worker runtime provide.
 *
 * @param text - the file contents
 */
export function encodeContent(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
