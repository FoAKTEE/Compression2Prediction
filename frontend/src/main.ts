import { createApp } from "vue";
import App from "./App.vue";
import { applyDocumentLang, i18n } from "./i18n";
import { createAppRouter } from "./router";
import "./styles/tokens.css";
import "./styles/base.css";

const app = createApp(App);
app.use(i18n);
app.use(createAppRouter());
applyDocumentLang(i18n.global.locale.value);
app.mount("#app");
