// Optional runtime vars, declared by hand. worker-configuration.d.ts is
// generated from .dev.vars.example, which deliberately does not set them, so
// the generated Env never depends on a local secret.
//
// INGEST_SECRET: only bound for a local ingest run; the deployed Worker has
//   none, which is what makes the /admin routes 404 in production.
// EMBEDDING_MODEL: overrides the default Workers AI embedding model.
interface Env {
  INGEST_SECRET?: string;
  EMBEDDING_MODEL?: string;
}

declare namespace Cloudflare {
  interface Env {
    INGEST_SECRET?: string;
    EMBEDDING_MODEL?: string;
  }
}
