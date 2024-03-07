//
//  armored_chat.js
//
//  Created by Armored Dragon, 2024.
//  Copyright 2024 Overte e.V.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html

(function () {
  "use strict";
  // TODO: Encryption + PMs
  // TODO: Find window init event method

  var app_is_visible = false;
  var settings = {
    max_history: 250,
    compact_chat: false,
    external_window: false,
  };
  var app_data = { current_page: "domain" };
  // Global vars
  var ac_tablet;
  var chat_overlay_window;
  var app_button;
  const channels = ["domain", "local", "system"];
  var max_local_distance = 20; // Maximum range for the local chat

  startup();

  function startup() {
    ac_tablet = Tablet.getTablet("com.highfidelity.interface.tablet.system");

    app_button = ac_tablet.addButton({
      icon: Script.resolvePath("./img/icon.png"),
      text: "CHAT",
      isActive: app_is_visible,
    });

    // When script ends, remove itself from tablet
    Script.scriptEnding.connect(function () {
      console.log("Shutting Down");
      ac_tablet.removeButton(app_button);
      chat_overlay_window.close();
    });

    // Overlay button toggle
    app_button.clicked.connect(toggleMainChatWindow);

    _openWindow();
  }
  function toggleMainChatWindow() {
    app_is_visible = !app_is_visible;
    console.log(`App is now ${app_is_visible ? "visible" : "hidden"}`);
    app_button.editProperties({ isActive: app_is_visible });
    chat_overlay_window.visible = app_is_visible;

    // External window was closed; the window does not exist anymore
    if (chat_overlay_window.title == "" && app_is_visible) {
      _openWindow();
    }
  }
  function _openWindow() {
    chat_overlay_window = new Desktop.createWindow(Script.resourcesPath() + "qml/hifi/tablet/DynamicWebview.qml", {
      title: "Overte Chat",
      size: { x: 550, y: 400 },
      additionalFlags: Desktop.ALWAYS_ON_TOP,
      visible: app_is_visible, // FIXME Invalid?
      presentationMode: Desktop.PresentationMode.VIRTUAL,
    });
    chat_overlay_window.visible = app_is_visible; // The "visible" field in the Desktop.createWindow does not seem to work. Force set it to false

    chat_overlay_window.closed.connect(toggleMainChatWindow);
    chat_overlay_window.sendToQml({ url: Script.resolvePath("./index.html") });
    // FIXME: Loadsettings need to happen after the window is initialized?
    // Script.setTimeout(_loadSettings, 1000);
    chat_overlay_window.webEventReceived.connect(onWebEventReceived);
  }

  // Initialize default message subscriptions
  Messages.subscribe("chat");
  // Messages.subscribe("system");

  Messages.messageReceived.connect(receivedMessage);

  function receivedMessage(channel, message) {
    console.log(`Received message:\n${message}`);
    var message = JSON.parse(message);

    channel = channel.toLowerCase();
    if (channel !== "chat") return;

    message.channel = message.channel.toLowerCase();

    // For now, while we are working on superseding Floof, we will allow compatibility with it.
    // If for_app exists, it came from us and we are just sending the message so Floof can read it.
    // We don't need to listen to this message.
    if (message.for_app) return;

    // Check the channel is valid
    if (!channels.includes(message.channel)) return;

    // FIXME: Not doing distance check?
    // If message is local, and if player is too far away from location, don't do anything
    if (channel === "local" && Vec3.distance(MyAvatar.position, message.position) < max_local_distance) return;

    // Floof chat compatibility.
    if (message.type) delete message.type;

    // Update web view of to new message
    _emitEvent({ type: "show_message", ...message });

    // Display on popup chat area
    _overlayMessage({ sender: message.displayName, message: message });
  }
  function onWebEventReceived(event) {
    console.log(`New web event:\n${event}`);
    // FIXME: Lazy!
    // Checks to see if the event is a JSON object
    if (!event.includes("{")) return;

    var parsed = JSON.parse(event);

    // Not our app? Not our problem!
    // if (parsed.app !== "ArmoredChat") return;

    switch (parsed.type) {
      case "page_update":
        app_data.current_page = parsed.page;
        break;

      case "send_message":
        _sendMessage(parsed.message);
        break;

      case "open_url":
        Window.openUrl(parsed.message.toString());
        break;

      case "setting_update":
        // Update local settings
        settings[parsed.setting_name] = parsed.setting_value;
        // Save local settings
        _saveSettings();

        switch (parsed.setting_name) {
          case "external_window":
            console.log(parsed.setting_value);
            chat_overlay_window.presentationMode = parsed.setting_value ? Desktop.PresentationMode.NATIVE : Desktop.PresentationMode.VIRTUAL;
            break;
        }
        break;

      case "initialized":
        _loadSettings();
        break;
    }
  }
  //
  // Sending messages
  // These functions just shout out their messages. We are listening to messages in an other function, and will record all heard messages there
  function _sendMessage(message) {
    Messages.sendMessage(
      "chat",
      JSON.stringify({
        position: MyAvatar.position,
        message: message,
        displayName: MyAvatar.sessionDisplayName,
        channel: app_data.current_page,
        action: "send_chat_message",
      })
    );

    // FloofyChat Compatibility
    Messages.sendMessage(
      "Chat",
      JSON.stringify({
        position: MyAvatar.position,
        message: message,
        displayName: MyAvatar.sessionDisplayName,
        channel: app_data.current_page.charAt(0).toUpperCase() + app_data.current_page.slice(1),
        type: "TransmitChatMessage",
        for_app: "Floof",
      })
    );

    // Show overlay of the message you sent
    _overlayMessage({ sender: MyAvatar.sessionDisplayName, message: message });
  }
  function _overlayMessage(message) {
    // Floofchat compatibility
    // This makes it so that our own messages are not rendered.
    // For now, Floofchat has priority over notifications as they use a strange system I don't want to touch yet.
    if (!message.action) return;

    Messages.sendLocalMessage(
      "Floof-Notif",
      JSON.stringify({
        sender: message.sender,
        text: message.message,
        color: { red: 122, green: 122, blue: 122 },
      })
    );
  }
  function _loadSettings() {
    console.log("Loading config");
    settings = Settings.getValue("ArmoredChat-Config", settings);
    console.log("\nSettings follow:");
    console.log(JSON.stringify(settings, " ", 4));

    // Compact chat
    if (settings.compact_chat) {
      _emitEvent({ type: "setting_update", setting_name: "compact_chat", setting_value: true });
    }

    // External Window
    if (settings.external_window) {
      chat_overlay_window.presentationMode = settings.external_window ? Desktop.PresentationMode.NATIVE : Desktop.PresentationMode.VIRTUAL;
      _emitEvent({ type: "setting_update", setting_name: "external_window", setting_value: true });
    }
  }
  function _saveSettings() {
    console.log("Saving config");
    Settings.setValue("ArmoredChat-Config", settings);
  }
  /**
   * Emit a packet to the HTML front end. Easy communication!
   * @param {Object} packet - The Object packet to emit to the HTML
   * @param {("setting_update"|"show_message")} packet.type - The type of packet it is
   */
  function _emitEvent(packet = { type: "" }) {
    chat_overlay_window.emitScriptEvent(JSON.stringify(packet));
  }
})();