import { describe, expect, it } from "vitest";
import { sanitizeSchema } from "./VoiceAgentHandler";

describe("sanitizeSchema", () => {
    it("keeps only portable realtime function parameter schema keys", () => {
        const schema = {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            propertyNames: { pattern: "^[a-z]+$" },
            patternProperties: {
                "^x-": { type: "string" },
            },
            properties: {
                count: {
                    type: "number",
                    description: "How many",
                    minimum: 1,
                    maximum: 10,
                    exclusiveMinimum: 0,
                    exclusiveMaximum: 11,
                    enum: [1, 2],
                    default: 1,
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string",
                        pattern: "^[a-z]+$",
                        examples: ["alpha"],
                    },
                },
                bbox: {
                    type: "array",
                    items: [
                        { type: "number" },
                        { type: "number" },
                        { type: "number" },
                        { type: "number" },
                    ],
                    minItems: 4,
                    maxItems: 4,
                },
                mode: {
                    oneOf: [{ type: "string" }],
                    anyOf: [{ type: "number" }],
                    allOf: [{ type: "boolean" }],
                },
            },
            required: ["count"],
        };

        expect(sanitizeSchema(schema)).toEqual({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    description: "How many",
                    enum: [1, 2],
                },
                tags: {
                    type: "array",
                    items: { type: "string" },
                },
                bbox: {
                    type: "array",
                    items: { type: "number" },
                },
                mode: {},
            },
            required: ["count"],
        });
    });
});
