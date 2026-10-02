(() => {
  "use strict";

  // All values are fictional. This demo never reads files or changes settings.
  window.MacwipeDemoStorage = {
    volumeName: "Macintosh HD",
    totalBytes: 512_000_000_000,
    availableBytes: 128_000_000_000,
    segments: [
      { label: "Apps", bytes: 96_000_000_000, color: "#a4527b" },
      { label: "Documents", bytes: 160_000_000_000, color: "#b7a0c3" },
      { label: "Downloads", bytes: 24_000_000_000, color: "#c6a05b" },
      { label: "Caches", bytes: 8_000_000_000, color: "#82966e" },
      { label: "Other", bytes: 96_000_000_000, color: "#9e8893" },
    ],
  };

  window.MacwipeData = {
    storage: {
      title: "Storage",
      description: "Review example files taking up space.",
      items: [
        {
          id: "old-backup",
          name: "Old device backup",
          mb: 1240,
          details:
            "An example backup from a previous device. Confirm you have another usable backup before removing any real copy.",
        },
        {
          id: "disk-image",
          name: "Archived disk image",
          mb: 680,
          details:
            "An example installer disk image. Keep installers you may need again, especially if they are no longer available.",
        },
        {
          id: "exports",
          name: "Temporary video exports",
          mb: 320,
          details:
            "Example exports from a finished project. Check that your original project and final exports are safely saved.",
        },
      ],
    },
    caches: {
      title: "Caches",
      description: "Explore temporary data that applications may rebuild.",
      items: [
        {
          id: "browser-cache",
          name: "Browser image cache",
          mb: 240,
          details:
            "Example cached images. Removing a real cache can make the next page load slower while images are downloaded again.",
        },
        {
          id: "thumbnail-cache",
          name: "Thumbnail cache",
          mb: 85,
          details:
            "Example file previews. An application may regenerate previews after its cache is cleared.",
        },
        {
          id: "app-cache",
          name: "Application cache",
          mb: 120,
          details:
            "Example temporary application data. Cache behavior varies by app; review its documentation and close the app first.",
        },
      ],
    },
    downloads: {
      title: "Downloads",
      description: "Find example downloads you may no longer need.",
      items: [
        {
          id: "installer",
          name: "Previous installer.dmg",
          mb: 420,
          details:
            "An example downloaded installer. Check that you can obtain it again before removing your real installer.",
        },
        {
          id: "archive",
          name: "Project archive.zip",
          mb: 156,
          details:
            "An example compressed project. Confirm its contents are extracted and backed up before deleting an archive.",
        },
        {
          id: "document",
          name: "Reference notes.pdf",
          mb: 12,
          details:
            "An example downloaded document. Personal documents should always be reviewed individually.",
        },
      ],
    },
    applications: {
      title: "Applications",
      description: "Review example apps and their estimated disk usage.",
      items: [
        {
          id: "photo-app",
          name: "Unused photo editor",
          mb: 860,
          details:
            "A fictional application. Removing an app may leave support files behind. Save its projects and licenses first.",
        },
        {
          id: "trial-app",
          name: "Expired trial app",
          mb: 210,
          details:
            "A fictional trial application. Check for saved work and use the developer’s uninstall instructions when available.",
        },
        {
          id: "legacy-app",
          name: "Legacy media player",
          mb: 95,
          details:
            "A fictional older player. Confirm another installed application supports the files you use.",
        },
      ],
    },
    startup: {
      title: "Startup",
      description:
        "Explore example login items. Sizes do not apply to settings.",
      items: [
        {
          id: "sync-login",
          name: "Example sync helper",
          mb: 0,
          info: "Login item",
          details:
            "A fictional helper that starts at login. Disabling a real sync helper may stop automatic syncing until you open its app.",
        },
        {
          id: "menu-login",
          name: "Example menu utility",
          mb: 0,
          info: "Login item",
          details:
            "A fictional menu bar utility. Disabling a login item changes startup behavior; it does not uninstall the application.",
        },
        {
          id: "update-login",
          name: "Example update agent",
          mb: 0,
          info: "Background item",
          details:
            "A fictional update agent. Disabling a real update agent can affect automatic updates. Review its purpose first.",
        },
      ],
    },
    performance: {
      title: "Performance",
      description:
        "Explore example activity. These entries have no cleanup size.",
      items: [
        {
          id: "cpu-task",
          name: "Example background task",
          mb: 0,
          info: "18% CPU",
          details:
            "An illustrative CPU reading, not a measurement of your Mac. Closing real tasks can interrupt work; save changes first.",
        },
        {
          id: "memory-app",
          name: "Example memory-heavy app",
          mb: 0,
          info: "640 MB RAM",
          details:
            "An illustrative memory reading. RAM usage is not reclaimable disk space. This demo cannot stop processes.",
        },
        {
          id: "indexing",
          name: "Example indexing task",
          mb: 0,
          info: "Active",
          details:
            "An illustrative indexing task. System indexing can be temporary and helps search; do not stop unfamiliar system processes.",
        },
      ],
    },
    privacy: {
      title: "Privacy",
      description: "Review example local history and website data.",
      items: [
        {
          id: "history",
          name: "Browser history",
          mb: 8,
          details:
            "Example local browsing history. Removing real history can remove useful records and may interact with browser sync settings.",
        },
        {
          id: "site-data",
          name: "Website data",
          mb: 32,
          details:
            "Example website storage. Clearing real website data may sign you out or remove offline content and preferences.",
        },
        {
          id: "recent-items",
          name: "Recent items list",
          mb: 0,
          info: "12 shortcuts",
          details:
            "Example recent-file shortcuts. Clearing such a list removes shortcuts, not the original files.",
        },
      ],
    },
  };
})();
