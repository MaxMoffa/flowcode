/** True when an error text reads like a network failure (no internet, DNS, refused/reset connection). */
const NETWORK_ERROR =
  /connection error|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|network (?:error|is unreachable)|socket hang up|unable to connect|could not resolve host|failed to connect|dns error|connection (?:refused|reset|timed out)/i;

export function isNetworkError(text: string): boolean {
  return NETWORK_ERROR.test(text);
}
