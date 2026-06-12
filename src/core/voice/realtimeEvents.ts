export interface RealtimeEvent {
    type?: string;
    [key: string]: unknown;
}

export interface FunctionCallItem {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
}

export function parseRealtimeEvent(data: string): RealtimeEvent | null {
    try {
        return JSON.parse(data) as RealtimeEvent;
    } catch {
        return null;
    }
}

export function parseArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Fall through to empty args; the model can recover from tool errors.
    }
    return {};
}

export function eventText(event: RealtimeEvent, key: string): string {
    const value = event[key];
    return typeof value === "string" ? value : "";
}

export function eventErrorMessage(event: RealtimeEvent): string {
    const error = event.error;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message);
    }
    return "unknown error";
}
