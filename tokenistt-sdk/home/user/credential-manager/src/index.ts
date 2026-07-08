import { app } from "./server";
import { PORT } from "./config";
import { selectBackend } from "./backends";

app.listen(PORT, () => {
  console.log(
    `credential-manager listening on :${PORT} (backend=${selectBackend().name})`,
  );
});
