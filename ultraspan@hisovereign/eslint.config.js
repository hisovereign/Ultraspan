module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        imports: "readonly",
        global: "readonly",
        Applet: "readonly",
        PopupMenu: "readonly",
        GLib: "readonly",
        Gio: "readonly",
        St: "readonly",
        Main: "readonly",
        Gettext: "readonly",
        Tooltips: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly"
      }
    },
    rules: {
      "complexity": ["error", 5],
      "max-lines-per-function": ["warn", 60],
      "max-depth": ["error", 3],
      "no-unused-vars": "error",
      "eqeqeq": ["error", "always"],
      "curly": "error",
      "no-empty": "error",
      "no-constant-condition": "error"
    }
  }
];
