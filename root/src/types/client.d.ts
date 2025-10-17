import { Client, Collection } from "discord.js";

declare module "discord.js" {
  export interface Client {
    slashCommands: Collection<string, any>;
  }
}