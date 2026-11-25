import { Client, Events, GatewayIntentBits, REST } from "discord.js";
import mongoose from "mongoose";
import {
  handleCommand,
  loadCommands,
  syncGlobalCommands,
  syncGuildModularCommands
} from "./commandRegistry.js";
import type { readConfig } from "../Config/config.js";
import { warnGuildSubscriptions } from "../Utils/permissionNotifier.js";

type Config = ReturnType<typeof readConfig>;

/** Creates, registers, and starts the Discord bot. */
export async function startBot(config: Config): Promise<Client> {
  if (config.mongodbUri) {
    await mongoose.connect(config.mongodbUri);
    console.log("Connected to MongoDB");
  } else {
    console.warn("MONGODB_URI is not set; database features are disabled.");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });
  await loadCommands();
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  const permissionSnapshots = new Map<string, string>();

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await syncGlobalCommands(rest, config.clientId);
      await Promise.all(
        readyClient.guilds.cache.map(async (guild) => {
          permissionSnapshots.set(guild.id, guild.members.me?.permissions.bitfield.toString() ?? "0");
          await syncGuildModularCommands(rest, config.clientId, guild);
          await warnGuildSubscriptions(readyClient, guild);
        })
      );
      const warningInterval = setInterval(() => {
        for (const guild of readyClient.guilds.cache.values()) {
          void warnGuildSubscriptions(readyClient, guild);
        }
      }, 60 * 60 * 1000);
      warningInterval.unref();
    } catch (error) {
      console.error("Initial command synchronization failed", error);
    }
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  /** Syncs modular commands only when the bot's effective guild permissions change. */
  const syncIfPermissionsChanged = async (guildId: string) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const permissions = guild.members.me?.permissions.bitfield.toString() ?? "0";
    if (permissionSnapshots.get(guildId) === permissions) return;
    permissionSnapshots.set(guildId, permissions);
    try {
      await syncGuildModularCommands(rest, config.clientId, guild);
      await warnGuildSubscriptions(client, guild);
      console.log(`Synchronized modular commands for guild ${guild.id}`);
    } catch (error) {
      console.error(`Modular command synchronization failed for guild ${guild.id}`, error);
    }
  };

  client.on(Events.GuildCreate, (guild) => {
    void syncIfPermissionsChanged(guild.id);
  });

  client.on(Events.ChannelUpdate, (_oldChannel, newChannel) => {
    if ("guild" in newChannel) {
      void syncIfPermissionsChanged(newChannel.guild.id);
      void warnGuildSubscriptions(client, newChannel.guild);
    }
  });

  client.on(Events.ChannelCreate, (channel) => {
    if ("guild" in channel) {
      void syncIfPermissionsChanged(channel.guild.id);
      void warnGuildSubscriptions(client, channel.guild);
    }
  });

  client.on(Events.ChannelDelete, (channel) => {
    if ("guild" in channel) {
      void syncIfPermissionsChanged(channel.guild.id);
      void warnGuildSubscriptions(client, channel.guild);
    }
  });

  client.on(Events.GuildRoleCreate, (role) => {
    void syncIfPermissionsChanged(role.guild.id);
  });

  client.on(Events.GuildRoleDelete, (role) => {
    void syncIfPermissionsChanged(role.guild.id);
  });

  client.on(Events.GuildRoleUpdate, (_oldRole, newRole) => {
    void syncIfPermissionsChanged(newRole.guild.id);
  });

  client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
    if (newMember.id === client.user?.id) {
      void syncIfPermissionsChanged(newMember.guild.id);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) {
      try {
        await handleCommand(interaction);
      } catch (error) {
        console.error("Command modal submission failed", error);
      }
      return;
    }

    if (interaction.isMessageComponent()) {
      try {
        await handleCommand(interaction);
      } catch (error) {
        console.error("Command component interaction failed", error);
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      try {
        await handleCommand(interaction);
      } catch (error) {
        console.error("Command autocomplete failed", error);
      }
      return;
    }

    if (!interaction.isChatInputCommand() &&
        !interaction.isUserContextMenuCommand() &&
        !interaction.isMessageContextMenuCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (error) {
      console.error("Command failed", error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("The command could not be completed.");
      } else {
        await interaction.reply({ content: "The command could not be completed.", ephemeral: true });
      }
    }
  });

  await client.login(config.botToken);
  return client;
}
