import type {
  AddonContext,
  AddonResult,
  ConfigKitAddon,
  DefaultModelAddonOptions,
  DefaultSlot,
} from "../types.js";

const SLOTS: DefaultSlot[] = ["opus", "sonnet", "haiku"];

export function defaultModel(options: DefaultModelAddonOptions): ConfigKitAddon {
  return {
    name: "default-model",
    apply(context: AddonContext): AddonResult {
      const warnings = [];
      const slots = options.claudeCode?.slots;

      if (slots !== undefined) {
        if (context.agent !== "claude-code") {
          warnings.push({
            code: "ADDON_SLOT_IGNORED",
            severity: "warning" as const,
            message: "claudeCode.slots only applies to Claude Code",
          });
        } else {
          for (const slot of Object.keys(slots)) {
            if (!SLOTS.includes(slot as DefaultSlot)) {
              warnings.push({
                code: "UNSUPPORTED_INTENT",
                severity: "warning" as const,
                message: `Unknown Claude Code default slot: ${slot}`,
                field: slot,
              });
            }
          }
        }
      }

      const intent =
        context.agent === "claude-code" && slots !== undefined
          ? {
              kind: "setDefaultModel" as const,
              modelId: options.modelId,
              slots: filterSlots(slots),
            }
          : { kind: "setDefaultModel" as const, modelId: options.modelId };

      return { intents: [intent], warnings };
    },
  };
}

function filterSlots(
  slots: Partial<Record<DefaultSlot, string>>,
): Partial<Record<DefaultSlot, string>> {
  const result: Partial<Record<DefaultSlot, string>> = {};
  for (const slot of SLOTS) {
    const value = slots[slot];
    if (value !== undefined) result[slot] = value;
  }
  return result;
}