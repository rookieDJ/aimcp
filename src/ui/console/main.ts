import { createApp } from "vue";
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./styles.css";

// Keep the reference theme stable, including Element Plus overlays teleported to body.
document.documentElement.classList.add("dark", "aimcp-console");

const root = document.getElementById("console-root");
if (!root) throw new Error("Console root is missing");

createApp(App).mount(root);
