import { ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { safeHttpGet, isRetryableProxyConnectionError, type SafeHttpOptions } from "../lib/http/safe-http.js";

export class OAuthRemoteUnavailableError extends ServerError {
    constructor() { super("OAuth client verification is temporarily unavailable; retry after network recovery"); }
}

/** No stale-key fallback: network failures remain fail-closed without invalidating credentials. */
export async function fetchOAuthDocument(url: URL, options: SafeHttpOptions, fetcher: typeof safeHttpGet = safeHttpGet) {
    try {
        const response = await fetcher(url, options);
        if (response.status === 408 || response.status === 429 || response.status >= 500) throw new OAuthRemoteUnavailableError();
        return response;
    } catch (error) {
        if (error instanceof OAuthRemoteUnavailableError) throw error;
        let cause: unknown = error;
        for (let i = 0; i < 5 && cause instanceof Error; i++) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (isRetryableProxyConnectionError(cause) || code === "EAI_AGAIN" || code === "ENOTFOUND") throw new OAuthRemoteUnavailableError();
            cause = cause.cause;
        }
        throw error;
    }
}
