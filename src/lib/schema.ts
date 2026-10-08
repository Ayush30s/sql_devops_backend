import { db } from "./db.ts";

/** Dataset metadata for the playground's schema browser and the editor's completion. */

export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  key?: "PK" | "FK";
  references?: string;
}

export interface DatasetTable {
  name: string;
  rowCount: number;
  columns: TableColumn[];
}

export interface DatasetSchema {
  slug: string;
  name: string;
  description: string;
  tables: DatasetTable[];
  /** table → column names, for the editor's completion. */
  completion: Record<string, string[]>;
}

const withCompletion = (d: { slug: string; name: string; description: string; tables: { name: string; rowCount: number; columns: unknown }[] }): DatasetSchema => {
  const tables = d.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, columns: t.columns as TableColumn[] }));
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    tables,
    completion: Object.fromEntries(tables.map((t) => [t.name, t.columns.map((c) => c.name)])),
  };
};

const SELECT = {
  slug: true,
  name: true,
  description: true,
  tables: { orderBy: { position: "asc" }, select: { name: true, rowCount: true, columns: true } },
} as const;

export async function datasetSchema(slug: string | null): Promise<DatasetSchema | null> {
  if (!slug) return null;
  const dataset = await db.sqlDataset.findUnique({ where: { slug }, select: SELECT });
  return dataset ? withCompletion(dataset) : null;
}

export async function allDatasetSchemas(): Promise<DatasetSchema[]> {
  const rows = await db.sqlDataset.findMany({ orderBy: { createdAt: "asc" }, select: SELECT });
  return rows.map(withCompletion);
}
