/** Turns PostgreSQL errors into short, teaching-oriented messages. */

const TYPOS: Record<string, string> = {
  FORM: "FROM", FRMO: "FROM", FRM: "FROM",
  SELCT: "SELECT", SLECT: "SELECT", SELET: "SELECT", SELEC: "SELECT", SEELCT: "SELECT",
  WHER: "WHERE", WEHRE: "WHERE", WHRE: "WHERE", HWERE: "WHERE",
  GROPU: "GROUP", GRUOP: "GROUP", GORUP: "GROUP", GROUPBY: "GROUP BY",
  ODER: "ORDER", ORDR: "ORDER", ORDERBY: "ORDER BY",
  HAIVNG: "HAVING", HAVNG: "HAVING",
  JION: "JOIN", JOING: "JOIN", INNNER: "INNER", LEFTJOIN: "LEFT JOIN",
  LIMT: "LIMIT", LIMTI: "LIMIT", DISTICT: "DISTINCT", DISTINT: "DISTINCT",
};

export interface FriendlyError {
  message: string;
  hint?: string;
}

interface PgErrorLike {
  code?: string;
  message: string;
  detail?: string;
  hint?: string;
}

export function friendlyError(err: PgErrorLike, tables: string[] = []): FriendlyError {
  const msg = err.message;
  const quoted = /"([^"]+)"/.exec(msg)?.[1] ?? "";
  switch (err.code) {
    case "42601": {
      const near = /at or near "([^"]*)"/.exec(msg)?.[1];
      if (!near) return { message: "Syntax error: the statement is incomplete.", hint: "Check for a missing closing parenthesis, quote, or keyword." };
      const fix = TYPOS[near.toUpperCase()];
      return {
        message: `Syntax error near "${near}".`,
        hint: fix ? `Did you mean ${fix}? Check the ${fix} keyword.` : "Look just before this word: a missing comma, keyword or quote is the usual cause.",
      };
    }
    case "42703":
      return {
        message: `Column "${quoted}" does not exist.`,
        hint: /^[A-Z]|\s/.test(quoted)
          ? `If you meant the text value '${quoted}', use single quotes. Double quotes are for column names.`
          : "Check the spelling. The schema browser lists every column. In a JOIN, prefix the column with its table alias.",
      };
    case "42P01":
      return {
        message: `Table "${quoted}" does not exist.`,
        hint: tables.length ? `Available tables: ${tables.join(", ")}.` : "Check the table name.",
      };
    case "42803":
      return {
        message: msg.charAt(0).toUpperCase() + msg.slice(1) + ".",
        hint: "Every column in SELECT must either appear in GROUP BY or be inside an aggregate such as COUNT(), SUM() or MAX().",
      };
    case "42702":
      return { message: `Column "${quoted}" is ambiguous.`, hint: "More than one table has this column. Prefix it with the table name or alias, for example c.id." };
    case "42883":
      return { message: msg.charAt(0).toUpperCase() + msg.slice(1) + ".", hint: err.hint ?? "Check the function name and its argument types. A cast such as ::numeric or ::text may help." };
    case "42804":
    case "22P02":
      return { message: msg.charAt(0).toUpperCase() + msg.slice(1) + ".", hint: "A value has the wrong type. Text needs single quotes; numbers don't." };
    case "22012":
      return { message: "Division by zero.", hint: "Wrap the divisor with NULLIF(divisor, 0) so the result becomes NULL instead of an error." };
    case "21000":
      return { message: "A subquery returned more than one row where only one value is allowed.", hint: "Use IN instead of =, or make the subquery return a single row (aggregate or LIMIT 1)." };
    case "23505":
    case "23503":
    case "23502":
    case "23514":
      return { message: msg.charAt(0).toUpperCase() + msg.slice(1) + ".", hint: err.detail };
    case "25P02":
      return { message: "An earlier statement failed, so this transaction is aborted.", hint: "Run ROLLBACK, fix the failing statement, and try again." };
    case "42501":
      return { message: "Permission denied in the practice sandbox.", hint: "The sandbox only allows working with the practice tables." };
    case "53300":
      return { message: "The SQL sandbox is busy right now.", hint: "Try again in a few seconds." };
  }
  return { message: msg.charAt(0).toUpperCase() + msg.slice(1), hint: err.hint };
}

/** 1-based line/column of a character offset. */
export function lineCol(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, col: offset - before.lastIndexOf("\n") };
}
