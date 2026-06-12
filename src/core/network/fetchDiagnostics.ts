export function isTransientFetchError(error: unknown): boolean {
    return error instanceof TypeError && error.message === "Failed to fetch";
}

export function logBackgroundFetchFailure(scope: string, error: unknown): void {
    if (isTransientFetchError(error)) {
        console.debug(`[${scope}] transient fetch interrupted`);
        return;
    }
    console.warn(`[${scope}] request failed:`, error);
}
