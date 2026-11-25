import {
  CheckboxGroupBuilder,
  CheckboxGroupOptionBuilder,
  LabelBuilder,
  MentionableSelectMenuBuilder,
  ModalBuilder,
} from "discord.js";

/**
 * Creates the context-menu inspect modal.
 *
 * The context flow uses Components V2 modal labels and a mentionable select.
 * Ephemeral behavior is represented by one checkbox instead of a legacy
 * string-select row. Public delivery is denied by the submit handler unless
 * the interacting member has permission to use external apps.
 */
export function buildInspectModal(
  kind: "user" | "message",
  id: string
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`inspect:modal:${kind}:${id}`)
    .setTitle(`Inspect ${kind === "user" ? "User" : "Message"}`)
    .setLabelComponents(
      new LabelBuilder()
        .setLabel("Mentions")
        .setDescription("Select users and/or roles to mention. Leave empty for none.")
        .setMentionableSelectMenuComponent(
          new MentionableSelectMenuBuilder()
            .setCustomId("inspect_mentions")
            .setPlaceholder("Select users and/or roles")
            .setMinValues(0)
            .setMaxValues(25)
            .setRequired(false)
        ),
      new LabelBuilder()
        .setLabel("Ephemeral")
        .setDescription("Selecting this option will omit the mentions in the response.")
        .setCheckboxGroupComponent(
          new CheckboxGroupBuilder()
            .setCustomId("ephemeral")
            .setMinValues(0)
            .setMaxValues(1)
            .setRequired(false)
            .setOptions(
              new CheckboxGroupOptionBuilder()
                .setLabel("Send as Ephemeral")
                .setValue("true")
                .setDescription("Only you can view this export")
                .setDefault(false)
            )
        )
    );
}
