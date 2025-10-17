# Developer Guide: Creating Dynamic Message Files

This guide explains how to create and structure the JSON files used by the dynamic command system, which powers the `/docs`, `/support`, and `/message` commands. This system allows you to add or modify complex, multi-page, and interactive bot messages without changing any of the bot's code. All content is loaded directly from the `messages/` directory at runtime.

## File Structure

The message files are organized by command and category within the `messages/` directory. This structure is used to automatically generate the subcommands you see in Discord.

-   **/docs**: `messages/docs/<category>/<filename>.json`
    -   Each folder under `messages/docs/` becomes a subcommand. For example, files in `messages/docs/discord-js/` will be available under the `/docs discord-js` subcommand.
-   **/support**: `messages/support/<category>/<filename>.json`
    -   The `/support` command has fixed subcommands (`general`, `developer`, `applications`). Your JSON files should be placed in the corresponding folder (e.g., `messages/support/general/`).
-   **/message**: `messages/!content/<category>/<filename>.json`
    -   The `/message` command reads from the `messages/!content` directory. Each subfolder becomes a category. For example, files in `messages/!content/playground/` are available under the `/message playground` subcommand.

### Subcommand Metadata (`_meta.json`)

You can customize the behavior of each subcommand category by creating a `_meta.json` file inside its folder (e.g., `messages/docs/discord-js/_meta.json` or `messages/!content/playground/_meta.json`). This file allows you to define custom descriptions, error messages, and recommendations.

| Field                      | Type                 | Description                                                                                                                            |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `description`              | String               | A custom description for the subcommand, shown in Discord's UI.                                                                        |
| `error_not_found`          | String or Object     | A custom message to show when a user's query doesn't match any document. Can be a simple string or a full, interactive message object.    |
| `recommendations`          | Array of Strings     | A list of document filenames (without `.json`) to suggest when a user's search query is empty.                                         |
| `available_tags`           | Array of Objects     | Defines the options for an interactive tag selection menu that appears after a search. See [Interactive Tag Recommendations](#interactive-tag-recommendations). |
| `tag_recommendation_limit` | Number               | The maximum number of recommendations to show in the tag follow-up message. Defaults to 5.                                             |

## JSON File Schema

Each `.json` file represents a single, potentially multi-page, message that the bot can send. The schema is highly flexible and supports most features of Discord messages, including embeds, components, and attachments.

### Top-Level Fields

| Field          | Type             | Required | Description                                                                                             |
| -------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `name`         | String           | Yes      | The user-friendly name of the document. This is shown in the autocomplete suggestions.                  |
| `description`  | String           | No       | A short description of the document, shown in tag search results.                                       |
| `pages`        | Array            | Yes      | An array of Discord message payloads. Each object is a page. See [The `pages` Array](#the-pages-array). |
| `tags`         | Array of Strings | No       | A list of strings for searchability. See [Searching with Tags and Priority](#searching-with-tags-and-priority). |
| `priority`     | Number (1-10)    | No       | A number from 1-10 to prioritize this document in searches. Higher is better.                           |
| `page_meta`    | Array            | No       | Metadata for the auto-generated "Jump to page" dropdown. See [Page Meta Object](#page-meta-object).     |
| `pagination`   | Object           | No       | Custom labels and emojis for the pagination buttons. See [Pagination Object](#pagination-object).       |
| `interactions` | Object           | No       | Defines actions for custom components (buttons, select menus). See [Interactions Object](#interactions-object). |

### Searching with Tags and Priority

You can add a `tags` array and a `priority` number to your JSON file to improve searchability. Users can find documents by typing `#` followed by a tag (e.g., `#intents`). Results are sorted by priority, with higher numbers appearing first. This allows you to surface the most important documents for common search terms.

**Example `tags` and `priority`:**
```json
"tags": ["permissions", "intents", "gateway", "privileged"],
"priority": 8
```

### The `pages` Array

This is the core of your file. Each object in the `pages` array is a standard Discord message payload that represents a single page. You can include `content`, `embeds`, `components`, and more.

#### Page Identification with `value`

Each page object can have a `value` property, which acts as a unique identifier for that page within the document. This identifier can be a `string` or a `number`.

-   **Initial Page**: To set a default page that appears when the command is first run, set its `value` to `"default"` or `"response"`. If no page is marked as default, the first page in the array (index 0) will be shown.
-   **Interaction Target**: The `value` is used by the `interactions` object to target a specific page for an `edit` or `followup` action when a user clicks a button or selects an option.

**Example `pages` structure:**
```json
"pages": [
  {
    "value": "default",
    "embeds": [{ "title": "Welcome!", "description": "This is the first page." }],
    "components": [
      {
        "type": 1,
        "components": [{ "type": 2, "label": "Show Details", "style": 1, "custom_id": "show_details_button" }]
      }
    ]
  },
  {
    "value": "details_page",
    "embeds": [{ "title": "Details", "description": "Here is more information." }]
  }
]
```

#### Per-Page `componentsV2`

The `componentsV2` flag is now defined **within each page object**.

-   **If `"componentsV2": true` (recommended):** The payload must use the modern component structure (`"type": 17`).
-   **If `componentsV2` is `false` or omitted:** The payload uses the legacy format.

### Page Meta Object

This is used for the auto-generated "Jump to page" dropdown menu, which allows users to navigate between pages by their index.

| Field         | Type   | Description                               |
| ------------- | ------ | ----------------------------------------- |
| `label`       | String | The text displayed for this option.       |
| `description` | String | The smaller text below the label.         |
| `value`       | String | The page index (as a string, e.g., `"0"`). |

### Pagination Object

This customizes the labels and emojis for the standard, index-based pagination buttons (`Previous` and `Next`).

| Field      | Type   | Description                               |
| ---------- | ------ | ----------------------------------------- |
| `previous` | Object | `{ "label": "Back", "emoji": "◀️" }`      |
| `next`     | Object | `{ "label": "Forward", "emoji": "▶️" }`   |
| `jump`     | Object | `{ "placeholder": "Select a section..." }` |

### Interactions Object

The `interactions` object is a key-value map where each key is the `custom_id` of a component (like a button or select menu) and the value defines the action to take when a user interacts with it.

| Action     | Description                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit`     | Edits the original message to show a different page. The value should be the `value` of the target page (e.g., `"edit": "details_page"`).                               |
| `followup` | Sends a new, ephemeral (visible only to the user) message. The value is a full message payload object.                                                                  |
| `modal`    | Opens a modal pop-up for user input. The value is a modal payload object.                                                                                               |
| `link`     | A simple action for buttons that just opens a URL. The value is the URL string. This only works for buttons.                                                            |

**Example `interactions` object:**
```json
"interactions": {
  "show_more_info": {
    "action": "edit",
    "page": "details_page"
  }
}
```
When a user clicks the button with `custom_id: "show_details_button"`, the bot will find the page with `"value": "details_page"` and edit the original message to show its content.