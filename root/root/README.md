# **.dev**

This project is a powerful, open-source Discord application that provides a suite of utilities and tools. It delivers real-time notifications for new commits from the Discord-Datamining repositories and monitors Discord's official status page for incidents and maintenance events. This ensures that your community remains informed about the latest platform developments and issues. Developed with Node.js, TypeScript, and Discord.js, the application features a flexible command system that is easily extendable through simple JSON configuration files.

## **Features**

* **Real-Time Datamining Updates**: Delivers instant notifications for new commits from the Discord-Datamining GitHub repositories directly to a designated Discord channel.  
* **Discord Status Monitoring**: Automatically monitors the official Discord Status page and reports active incidents and maintenance events to your server.  
* **Dynamic Content System**: Serves rich, multi-page messages for commands such as /docs, /support, and /message. Content is managed through JSON files, allowing for effortless updates without modifying the application's source code.  
* **Flexible Installation**: Supports both server-wide (Guild) and user-specific (User) installations for greater control over application deployment.  
* **Subscription Management**: Provides simple commands (/subscribe, /unsubscribe) for users to manage their notification preferences.  
* **Robust and Performant**: Engineered with modern technologies including ESNext modules and sharp for image processing, all within a clean and well-organized codebase for simplified maintenance.

## **Installation**

This application supports two primary installation methods:

* **User Install**: Intended for individual users who wish to utilize the application's commands within a server without requiring formal installation by a server administrator. The application will not be visible in the server's member list, but its commands will be accessible to the authorizing user. This method is available via the /auth endpoint.  
* **Guild Install (Recommended)**: The standard method for server owners and administrators to add the application to their server, making it available to all members. This is facilitated through a traditional "invite" link. This method is available via the /invite endpoint.

## **Project Structure**

The project is organized into the following key directories:

* src/: Contains the core application source code.  
  * bot.ts: The main entry point for the Discord bot.  
  * Commands/: Contains all command handlers, organized by category (General, Management, Subscription, Tools, Moderation).  
  * Models/: Defines the Mongoose schemas for all database models.  
  * Utils/: Includes various utility functions and helper modules.  
  * Assets/: Stores static assets and resources, such as fonts and badge generators.  
* messages/: Contains the JSON files that define the content for dynamic commands.  
* public/: Contains public-facing files for the web server, such as the OAuth success page.

## **Setup Instructions**

1. **Clone the Repository**:  
   git clone \<repository-url\>  
   cd discord.dev

2. **Install Dependencies**:  
   npm install

3. Configure Environment Variables:  
   Create a .env file in the root directory. You may use .env.example as a template if one is provided. The file must contain the following variables:  
   \# Your Discord bot's token from the Discord Developer Portal  
   DISCORD\_TOKEN=your\_discord\_bot\_token

   \# Your MongoDB connection string  
   MONGODB\_URI=your\_mongodb\_connection\_string

   \# The Client ID of your Discord application  
   CLIENT\_ID=your\_discord\_app\_client\_id

   \# The port for the webhook server (optional, defaults to 3000\)  
   PORT=3000

4. Run the Application:  
   To start the application in development mode with automatic reloading, execute:  
   npm run dev

   For a production environment, first build the project with npm run build, and then start it with npm start.

## **Usage**

* **/debug**: (Owner-only) A suite of commands for debugging the application's state.  
* **/docs**: Displays dynamic documentation messages from the messages/docs directory.  
* **/message**: Displays custom, content-rich messages from the messages/\!content directory.  
* **/notify**: Manage role notifications for updates.  
* **/subscribe**: Subscribe to updates from the Discord-Datamining repository.  
* **/support**: Displays help and support messages from the messages/support directory.  
* **/unsubscribe**: Unsubscribe from receiving updates.  
* **Receive Notifications**: The application will send notifications to the specified channels for new commits or status incidents.

## **Development**

For information regarding the addition of new documentation and support messages, please refer to [**DEV-GUIDE.md**](https://www.google.com/search?q=DEV-GUIDE.md).

## **Contributing**

Contributions are welcome. If you would like to contribute, please fork the repository and create a feature branch. Pull requests are greatly appreciated.

1. Fork the repository.  
2. Create your feature branch (git checkout \-b feature/your-amazing-feature).  
3. Commit your changes (git commit \-m 'Add your amazing feature').  
4. Push to the branch (git push origin feature/your-amazing-feature).  
5. Open a Pull Request.

## **License**

This project is licensed under the MIT License. Please see the LICENSE file for full details.