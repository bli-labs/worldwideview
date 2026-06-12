const TOOL_SCHEMA_KEYS = new Set(["description", "enum", "items", "properties", "required", "type"]);

function sanitizeItems(value: unknown): unknown {
    if (!Array.isArray(value)) return sanitizeSchema(value);
    const sanitizedItems = value
        .map(sanitizeSchema)
        .filter((item): item is Record<string, unknown> => (
            item !== null && typeof item === "object" && !Array.isArray(item)
        ));
    return sanitizedItems[0] ?? {};
}

/**
 * Realtime function tools accept JSON-schema-shaped parameters, but our MCP
 * tools may include stricter draft keywords. Keep the portable subset.
 * Tuple arrays are normalized to a single item schema because Realtime rejects
 * JSON Schema's array-form `items`.
 */
export function sanitizeSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeSchema);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if (key === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
                out.properties = Object.fromEntries(
                    Object.entries(v as Record<string, unknown>).map(([name, schema]) => [
                        name,
                        sanitizeSchema(schema),
                    ]),
                );
            } else if (key === "items") {
                out.items = sanitizeItems(v);
            } else if (TOOL_SCHEMA_KEYS.has(key)) {
                out[key] = sanitizeSchema(v);
            }
        }
        return out;
    }
    return value;
}
