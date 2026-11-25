import {
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";

export interface InspectResult {
  id: string;
  name: string;
  data: unknown;
}

/** Converts Discord values and circular structures into stable, readable JSON. */
export function toRawInspectData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  const source = "toJSON" in value &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;

  if (Array.isArray(source)) {
    return source.map((item) => toRawInspectData(item, seen));
  }
  if (source === null || typeof source !== "object") return source;

  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [
      key
        .replace(/[A-Z]+(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[0-9]+/g, (word) =>
          `${word.toLowerCase()}_`
        )
        .replace(/^_|_$/g, "")
        .replace(/__+/g, "_"),
      toRawInspectData(item, seen)
    ])
  );
}

/** Produces a Discord-safe attachment filename. */
export function sanitizeInspectFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "data";
}

/**
 * Builds the public inspect payload and JSON/TXT buttons.
 *
 * @param interaction The originating slash interaction.
 * @param kind The inspect subcommand or target category.
 * @param result The resolved object and export name.
 * @returns Discord Components V2 payload fields.
 */
export function buildInspectPayload(
  interaction: ChatInputCommandInteraction,
  kind: string,
  result: InspectResult
) {
  const json = JSON.stringify(
    toRawInspectData(result.data),
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
    2
  );
  const jsonName = `${sanitizeInspectFilename(result.name)}.json`;
  const jsonFile = new AttachmentBuilder(Buffer.from(json), { name: jsonName });

  const components: any[] = [{
    type: 17,
    components: [
      {
        type: 10,
        content: `### -# <:Hammer_n_Chisel:1444239406750761080> </inspect ${kind}:${interaction.commandId}>`
      },
      { type: 13, file: { url: `attachment://${jsonName}`, name: jsonName } },
      {
        type: 10,
        content: "-# Previewing assets or human-readable information? Use </info:1433219473036542114>"
      },
      { type: 14, divider: false },
      {
        type: 1,
        components: [
          new ButtonBuilder()
            .setCustomId(`inspect:${kind}:${result.id}:json`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji({ name: "Preview", id: "1444242429581459476" })
            .toJSON(),
          new ButtonBuilder()
            .setCustomId(`inspect:${kind}:${result.id}:txt`)
            .setLabel("View TXT")
            .setStyle(ButtonStyle.Secondary)
            .toJSON()
        ]
      }
    ]
  }];

  return { json, jsonFile, jsonName, components };
}

/**
 * Builds the public context-menu inspect payload without requiring a slash
 * interaction or slash command ID.
 */
export function buildContextInspectPayload(
  kind: "user" | "message",
  id: string,
  name: string,
  data: unknown,
  mentions?: string
) {
  const json = JSON.stringify(
    toRawInspectData(data),
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
    2
  );
  const jsonName = `${sanitizeInspectFilename(name)}.json`;
  const jsonFile = new AttachmentBuilder(Buffer.from(json), { name: jsonName });
  const components: any[] = [{
    type: 17,
    components: [
      {
        type: 10,
        content: `### -# <:Hammer_n_Chisel:1444239406750761080> Inspect ${kind === "user" ? "User" : "Message"}`
      },
      { type: 13, file: { url: `attachment://${jsonName}`, name: jsonName } },
      {
        type: 10,
        content: "-# Previewing assets or human-readable information? Use </info:1433219473036542114>"
      },
      { type: 14, divider: false },
      {
        type: 1,
        components: [
          new ButtonBuilder()
            .setCustomId(`inspect:${kind}:${id}:json`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji({ name: "Preview", id: "1444242429581459476" })
            .toJSON(),
          new ButtonBuilder()
            .setCustomId(`inspect:${kind}:${id}:txt`)
            .setLabel("View TXT")
            .setStyle(ButtonStyle.Secondary)
            .toJSON()
        ]
      }
    ]
  }];
  if (mentions) components.push({ type: 10, content: mentions });
  return { json, jsonFile, jsonName, components };
}
