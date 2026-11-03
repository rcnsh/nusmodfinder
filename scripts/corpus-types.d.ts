// Shapes shared by the Node side (scripts/, vitest.config.mjs) and the
// Worker-side tests. No imports, so both tsconfig projects can include it.

/** One module as normalised by scripts/lib.mjs `normalise()`. */
interface NormalisedModule {
  code: string;
  title: string;
  description: string;
  credits: number | null;
  department: string | null;
  faculty: string | null;
  level: number | null;
  semesters: number[];
  workload: string | null;
  prerequisite: string | null;
  preclusion: string | null;
  acadYear: string;
  text: string;
  textHash: string;
  ng: boolean;
  ngSemesters: number[];
}

/** What vitest.config.mjs `provide`s as `corpus` (null when unavailable). */
interface FullCorpus {
  acadYear: string;
  moduleInfoSha256: string;
  recordCount: number;
  /** Codes of every record with at least one semesterData entry. */
  offeredCodes: string[];
  modules: NormalisedModule[];
  skipped: { code: string; why: string }[];
  ng: { updatedAsAt: string | null; semesters: Record<string, string[]> };
}

/** test/fixtures/corpus.json, written by scripts/build-fixture.mjs. */
interface FixtureCorpus {
  source: {
    release: string;
    moduleInfo: string;
    moduleInfoSha256: string;
    ng: string;
    ngSha256: string;
    acadYear: string;
    generator: string;
  };
  count: number;
  reasonCounts: Record<string, number>;
  /** Why each module was selected, e.g. `["management-sem3", "named"]`. */
  reasons: Record<string, string[]>;
  modules: NormalisedModule[];
}
