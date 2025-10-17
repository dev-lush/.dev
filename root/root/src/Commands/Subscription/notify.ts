import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  AutocompleteInteraction,
  RoleSelectMenuBuilder,
  ComponentType,
  MessageFlags,
  InteractionContextType,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  RoleSelectMenuInteraction
} from 'discord.js';
import { RoleMentionsHandler } from '../../Models/RoleMentionsHandler.js';
import { Subscription, SubscriptionType } from '../../Models/Subscription.js';
import { format } from 'date-fns';
import { commandGuard } from '../../Utils/commandGuard.js';

const PREVIEWS_CATEGORIES = ['Strings', 'Experiments', 'Endpoints', 'Dismissible Content', 'Miscellaneous'];
const STATUS_IMPACTS = ['None', 'Minor', 'Major', 'Critical'];

/**
 * Handles the role selection logic from a RoleSelectMenuInteraction.
 * It finds or creates a RoleMentionsHandler document for the selected role and category.
 * @param interaction The RoleSelectMenuInteraction.
 * @param subscriptionType The type of the subscription ('previews' or 'status').
 * @param customIdParts The parts of the custom ID, used to identify the subscription and category.
 */
async function handleRoleSelection(interaction: RoleSelectMenuInteraction, subscriptionType: string, customIdParts: string[]) {
  // Correctly parse the custom ID parts: [type, 'setrole', subId, category]
  const subId = customIdParts[2];
  const category = customIdParts[3];

  const role = interaction.roles.first();
  if (!role) return interaction.reply({ content: 'No role selected.', flags: MessageFlags.Ephemeral });

  const query = {
    guildId: interaction.guildId!,
    type: subscriptionType,
    value: `${subId}:${category}`
  };

  const existing = await RoleMentionsHandler.findOne(query);

  if (existing) {
    await RoleMentionsHandler.deleteOne({ _id: existing._id });
    return interaction.reply({ content: `<:Checkmark:1425291737550557225> ${role} removed from **${category}** mentions.`, flags: MessageFlags.Ephemeral });
  }

  await RoleMentionsHandler.findOneAndUpdate(query, { roleId: role.id }, { upsert: true });

  let warning = '';
  const botMember = interaction.guild?.members?.me;
  if (botMember) {
      const canMention = role.mentionable || botMember.permissions.has('MentionEveryone');
      if (!canMention) {
          warning = ' However, the app **might not be able** to mention this role due to [insufficient permissions](<https://support.discord.com/hc/en-us/articles/360039176412-Role-Mention-Permissions-Suppression>).';
      }
  }

  return interaction.reply({
    content: `<:Checkmark:1425291737550557225> ${role} will now be mentioned for **${category}**.${warning}`,
    flags: MessageFlags.Ephemeral
  });
}

/**
 * Displays the UI for selecting roles for different Discord Previews categories.
 * @param interaction The ButtonInteraction that triggered this UI.
 * @param subId The ID of the subscription being configured.
 */
async function showPreviewsCategorySelector(interaction: ButtonInteraction, subId: string) {
  const container: any[] = [
    { type: 10, content: '# <:Discord_Previews:1404064048110370976> Discord Previews\n## Mention by Category\nSelect roles to mention for each preview section.' },
    { type: 14, spacing: 2 }
  ];

  for (let i = 0; i < PREVIEWS_CATEGORIES.length; i++) {
    const key = PREVIEWS_CATEGORIES[i];
    container.push({ type: 10, content: `## ${key}` });
    if (key === 'Miscellaneous') {
      container.push({ type: 10, content: 'Anything that doesn\'t fit the categories above will fall under this.' });
    }
    const select = new RoleSelectMenuBuilder()
      .setCustomId(`previews_setrole_${subId}_${key}`)
      .setPlaceholder(`Select role for ${key}`)
      .setMaxValues(1);
    container.push({ type: 1, components: [select.toJSON()] });
    if (i < PREVIEWS_CATEGORIES.length - 1) {
      container.push({ type: 14, spacing: 2 });
    }
  }

  await interaction.reply({
    components: [{ type: 17, components: container }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.RoleSelect,
    time: 180_000,
    filter: i => i.user.id === interaction.user.id
  });

  collector.on('collect', async select => {
    await handleRoleSelection(select, 'previews', select.customId.split('_'));
  });
}

/**
 * Displays the UI for selecting roles for different Discord Status impact levels.
 * @param interaction The ButtonInteraction that triggered this UI.
 * @param subId The ID of the subscription being configured.
 */
async function showStatusImpactSelector(interaction: ButtonInteraction, subId: string) {
  const container: any[] = [
    { type: 10, content: '# <:Discord_Status:1427642694183817369> Discord Status\n##Mention by Impact\nSelect roles to mention for each incident impact level.' },
    { type: 14, spacing: 2 }
  ];

  for (let i = 0; i < STATUS_IMPACTS.length; i++) {
    const key = STATUS_IMPACTS[i];
    container.push({ type: 10, content: `## ${key}` });
    const select = new RoleSelectMenuBuilder()
      .setCustomId(`status_setrole_${subId}_${key}`)
      .setPlaceholder(`Select role for ${key}`)
      .setMaxValues(1);
    container.push({ type: 1, components: [select.toJSON()] });
    if (i < STATUS_IMPACTS.length - 1) {
      container.push({ type: 14, spacing: 2 });
    }
  }

  await interaction.reply({
    components: [{ type: 17, components: container }],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
  });

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.RoleSelect,
    time: 180_000,
    filter: i => i.user.id === interaction.user.id
  });

  collector.on('collect', async select => {
    await handleRoleSelection(select, 'status', select.customId.split('_'));
  });
}


export default {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Manage role-mention pings for subscriptions.')
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setContexts([InteractionContextType.Guild])
    .addStringOption(opt =>
      opt.setName('subscription')
        .setDescription('Subscription to configure.')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.resolve([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.MentionEveryone
      ])
    ),

  /**
   * Handles autocomplete for the 'subscription' option.
   * @param interaction The autocomplete interaction.
   */
  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'subscription') return;

    const subs = await Subscription.find({ guildId: interaction.guildId });

    const choices = await Promise.all(subs.map(async sub => {
      const guild = interaction.guild!;
      const channel = guild.channels.cache.get(sub.channelId)
        ?? await guild.channels.fetch(sub.channelId).catch(() => null);
      const user = await interaction.client.users.fetch(sub.userId).catch(() => null);

      const category = sub.type === SubscriptionType.STATUS ? 'Discord Status' : 'Discord Previews';
      const channelName = channel?.isTextBased() ? `#${channel.name}` : 'Unknown Channel';
      const username = user?.username ?? 'Unknown User';
      const date = sub.createdAt ? format(sub.createdAt, 'd MMMM yyyy') : 'Unknown Date';

      return {
        name: `${channelName}: ${category} | ${username} | ${date}`,
        value: sub._id.toString()
      };
    }));

    await interaction.respond(choices.slice(0, 25));
  },

  /**
   * Executes the /notify command.
   * @param interaction The chat input command interaction.
   */
  async execute(interaction: ChatInputCommandInteraction) {
    const guardResult = await commandGuard(interaction, {
      guildOnly: true,
      requireMemberPermissions: ['ManageGuild', 'ManageRoles', 'MentionEveryone']
    });
    if (!guardResult) return;

    const subId = interaction.options.getString('subscription', true);
    const sub = await Subscription.findById(subId);
    if (!sub) return interaction.reply({ content: '<:Cross:1425291759952593066> Subscription not found.', flags: MessageFlags.Ephemeral });

    const subType = sub.type as 'previews' | 'status';

    if (subType === 'previews') {
      const container: any[] = [
        { type: 10, content: '# <:Discord_Previews:1404064048110370976> Discord Previews\nConfigure role mentions for Discord Previews.' },
        { type: 14, spacing: 2 },
        { type: 10, content: '## Universal Mention\nThis role will be mentioned for all new commit comments, regardless of category.' },
        { type: 1, components: [new RoleSelectMenuBuilder().setCustomId(`previews_setrole_${subId}_universal`).setPlaceholder('Select a universal role').setMaxValues(1).toJSON()] },
        { type: 14 },
        { type: 10, content: '## Mention by Category\nConfigure roles to be mentioned for specific content categories.' },
        { type: 1, components: [new ButtonBuilder().setCustomId(`previews_expand_${subId}`).setLabel('Expand').setEmoji({ name: 'Options', id: '1406571002791465042' }).setStyle(ButtonStyle.Secondary).toJSON()] }
      ];
      await interaction.reply({ components: [{ type: 17, components: container }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    } else if (subType === 'status') {
      const container: any[] = [
        { type: 10, content: '# <:Discord_Status:1427642694183817369> Discord Status\nConfigure role mentions for Discord Status updates.' },
        { type: 14, spacing: 2 },
        { type: 10, content: '## Universal Mention\nThis role will be mentioned for all incidents and maintenances.' },
        { type: 1, components: [new RoleSelectMenuBuilder().setCustomId(`status_setrole_${subId}_universal`).setPlaceholder('Select a universal role').setMaxValues(1).toJSON()] },
        { type: 14 },
        { type: 10, content: '## Mention by Category\nAssign roles for incidents or maintenances specifically.' },
        { type: 1, components: [new RoleSelectMenuBuilder().setCustomId(`status_setrole_${subId}_Incident`).setPlaceholder('Select a role for Incidents').setMaxValues(1).toJSON()] },
        { type: 1, components: [new RoleSelectMenuBuilder().setCustomId(`status_setrole_${subId}_Maintenance`).setPlaceholder('Select a role for Maintenances').setMaxValues(1).toJSON()] },
        { type: 14 },
        { type: 10, content: '## Mention by Impact\nConfigure roles for specific incident impact levels.' },
        { type: 1, components: [new ButtonBuilder().setCustomId(`status_expand_${subId}`).setLabel('Expand').setEmoji({ name: 'Options', id: '1406571002791465042' }).setStyle(ButtonStyle.Secondary).toJSON()] }
      ];
      await interaction.reply({ components: [{ type: 17, components: container }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
    }

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: 180_000,
      filter: i => i.user.id === interaction.user.id
    });

    collector.on('collect', async i => {
      const [type, action, id] = i.customId.split('_');
      if (id !== subId) return;

      if (i.isButton()) {
        if (action === 'expand') {
          if (type === 'previews') await showPreviewsCategorySelector(i, subId);
          else if (type === 'status') await showStatusImpactSelector(i, subId);
        }
      } else if (i.isRoleSelectMenu()) {
        if (action === 'setrole') {
          await handleRoleSelection(i, type, i.customId.split('_'));
        }
      }
    });

    collector.on('end', () => {
      interaction.editReply({ content: 'Notification editor has expired.', components: [] }).catch(() => {});
    });
  }
};