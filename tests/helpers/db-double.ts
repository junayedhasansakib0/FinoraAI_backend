import { Prisma } from '../../src/generated/prisma/client.js';

/**
 * In-memory stand-in for the Prisma singleton, shared by the categories and transactions
 * suites. R-T2 rules out the hosted database and this machine has no disposable Postgres, so
 * the double implements exactly the queries those two services issue — nothing more. Anything
 * unsupported throws instead of quietly returning a wrong answer, so a service that starts
 * using a new operator fails the suite rather than passing on a lie.
 */

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence)}`;
}

export interface StoredCategory {
  id: string;
  userId: string;
  name: string;
  type: string;
  isDefault: boolean;
  createdAt: Date;
}

export interface StoredTransaction {
  id: string;
  userId: string;
  type: string;
  amount: Prisma.Decimal;
  categoryId: string | null;
  description: string | null;
  date: Date;
  createdAt: Date;
}

export interface StoredBudget {
  id: string;
  userId: string;
  categoryId: string | null;
}

export const store = {
  categories: [] as StoredCategory[],
  transactions: [] as StoredTransaction[],
  budgets: [] as StoredBudget[],
};

export function resetStore(): void {
  store.categories = [];
  store.transactions = [];
  store.budgets = [];
  sequence = 0;
}

/** Fixed timestamp so ordering in the fixtures depends only on the fields under test. */
const SEEDED_AT = new Date('2026-01-01T00:00:00.000Z');

export function seedCategory(input: {
  userId: string;
  name: string;
  type: string;
  isDefault?: boolean;
}): StoredCategory {
  const row: StoredCategory = {
    id: nextId('cat'),
    userId: input.userId,
    name: input.name,
    type: input.type,
    isDefault: input.isDefault ?? false,
    createdAt: SEEDED_AT,
  };
  store.categories.push(row);
  return row;
}

export function seedTransaction(input: {
  userId: string;
  type: string;
  amount: string;
  date: string;
  categoryId?: string | null;
  description?: string | null;
}): StoredTransaction {
  const row: StoredTransaction = {
    id: nextId('txn'),
    userId: input.userId,
    type: input.type,
    amount: new Prisma.Decimal(input.amount),
    categoryId: input.categoryId ?? null,
    description: input.description ?? null,
    date: new Date(input.date),
    createdAt: SEEDED_AT,
  };
  store.transactions.push(row);
  return row;
}

export function seedBudget(input: { userId: string; categoryId: string | null }): StoredBudget {
  const row: StoredBudget = {
    id: nextId('bud'),
    userId: input.userId,
    categoryId: input.categoryId,
  };
  store.budgets.push(row);
  return row;
}

type Row = Record<string, unknown>;
type Select = Record<string, boolean | { select: Record<string, boolean> }>;
type OrderBy = Record<string, 'asc' | 'desc'>;

/** One cast, in one place, so the rest of the double stays typed. */
function fieldOf(row: object, field: string): unknown {
  return (row as Row)[field];
}

function isOperatorObject(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !(value instanceof Prisma.Decimal)
  );
}

/** Dates and decimals compare numerically; anything else compares as text. */
function asNumber(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function compareValues(left: unknown, right: unknown): number {
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);

  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }

  const leftText = String(left);
  const rightText = String(right);

  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function quoteRegExp(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Postgres `ILIKE`, applied to the pattern the service actually sends. A `%` the service failed
 * to escape would match everything here too, which is what makes the R-V5 test meaningful.
 */
function likeToRegExp(pattern: string): RegExp {
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';

    if (character === '\\') {
      index += 1;
      source += quoteRegExp(pattern[index] ?? '');
    } else if (character === '%') {
      source += '.*';
    } else if (character === '_') {
      source += '.';
    } else {
      source += quoteRegExp(character);
    }
  }

  return new RegExp(source, 'i');
}

function matchesWhere(row: object, where: Row): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = fieldOf(row, field);

    if (!isOperatorObject(condition)) {
      return condition === null ? value === null : compareValues(value, condition) === 0;
    }

    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        // Text comparison in the double is case-insensitive throughout.
        case 'mode':
          return true;
        case 'equals':
          return compareValues(value, operand) === 0;
        case 'gte':
          return compareValues(value, operand) >= 0;
        case 'lte':
          return compareValues(value, operand) <= 0;
        case 'contains':
          return typeof value === 'string' && likeToRegExp(String(operand)).test(value);
        default:
          throw new Error(`db-double: unsupported filter operator "${operator}"`);
      }
    });
  });
}

function filterRows<T extends object>(rows: T[], where: Row | undefined): T[] {
  return where === undefined ? [...rows] : rows.filter((row) => matchesWhere(row, where));
}

function sortRows<T extends object>(rows: T[], orderBy: OrderBy[] | undefined): T[] {
  if (orderBy === undefined) {
    return rows;
  }

  return [...rows].sort((left, right) => {
    for (const clause of orderBy) {
      for (const [field, direction] of Object.entries(clause)) {
        const result = compareValues(fieldOf(left, field), fieldOf(right, field));

        if (result !== 0) {
          return direction === 'asc' ? result : -result;
        }
      }
    }
    return 0;
  });
}

/** Honours the caller's `select`, so a field a service forgot to exclude would surface. */
function projectFields(row: object, select: Record<string, boolean>): Row {
  const projection: Row = {};

  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) {
      projection[field] = fieldOf(row, field);
    }
  }

  return projection;
}

function projectTransaction(row: StoredTransaction, select: Select | undefined): Row {
  if (select === undefined) {
    return { ...row };
  }

  const projection: Row = {};

  for (const [field, spec] of Object.entries(select)) {
    if (spec === true) {
      projection[field] = fieldOf(row, field);
    } else if (spec !== false) {
      if (field !== 'category') {
        throw new Error(`db-double: unsupported relation "${field}"`);
      }
      const related = store.categories.find((category) => category.id === row.categoryId);
      projection.category = related === undefined ? null : projectFields(related, spec.select);
    }
  }

  return projection;
}

function knownRequestError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });
}

/** The `(userId, name, type)` index the services rely on for their 409s (R-D6). */
function nameTaken(candidate: StoredCategory, excludeId?: string): boolean {
  return store.categories.some(
    (row) =>
      row.id !== excludeId &&
      row.userId === candidate.userId &&
      row.type === candidate.type &&
      row.name === candidate.name,
  );
}

interface CategoryFindArgs {
  where?: Row;
  select?: Record<string, boolean>;
  orderBy?: OrderBy[];
}

function projectCategory(row: StoredCategory, select: Record<string, boolean> | undefined): Row {
  return select === undefined ? { ...row } : projectFields(row, select);
}

const category = {
  findMany({ where, select, orderBy }: CategoryFindArgs): Promise<Row[]> {
    const rows = sortRows(filterRows(store.categories, where), orderBy);

    return Promise.resolve(rows.map((row) => projectCategory(row, select)));
  },

  findFirst({ where, select }: CategoryFindArgs): Promise<Row | null> {
    const row = filterRows(store.categories, where)[0];

    return Promise.resolve(row === undefined ? null : projectCategory(row, select));
  },

  count({ where }: CategoryFindArgs): Promise<number> {
    return Promise.resolve(filterRows(store.categories, where).length);
  },

  create(args: {
    data: { userId: string; name: string; type: string };
    select?: Record<string, boolean>;
  }): Promise<Row> {
    const row: StoredCategory = {
      id: nextId('cat'),
      userId: args.data.userId,
      name: args.data.name,
      type: args.data.type,
      isDefault: false,
      createdAt: new Date(),
    };

    if (nameTaken(row)) {
      return Promise.reject(knownRequestError('P2002', 'Unique constraint failed'));
    }

    store.categories.push(row);

    return Promise.resolve(projectCategory(row, args.select));
  },

  update(args: {
    where: Row;
    data: { name?: string };
    select?: Record<string, boolean>;
  }): Promise<Row> {
    const row = filterRows(store.categories, args.where)[0];

    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to update not found'));
    }

    if (args.data.name !== undefined && nameTaken({ ...row, name: args.data.name }, row.id)) {
      return Promise.reject(knownRequestError('P2002', 'Unique constraint failed'));
    }

    Object.assign(row, args.data);

    return Promise.resolve(projectCategory(row, args.select));
  },

  /** The foreign key is `SetNull`, so the category's transactions stay and lose their link (R-D7). */
  delete(args: { where: Row; select?: Record<string, boolean> }): Promise<Row> {
    const row = filterRows(store.categories, args.where)[0];

    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to delete does not exist'));
    }

    store.categories = store.categories.filter((candidate) => candidate.id !== row.id);

    for (const transaction of store.transactions) {
      if (transaction.categoryId === row.id) {
        transaction.categoryId = null;
      }
    }

    return Promise.resolve(projectCategory(row, args.select));
  },
};

interface TransactionFindArgs {
  where?: Row;
  select?: Select;
  orderBy?: OrderBy[];
  skip?: number;
  take?: number;
}

interface TransactionData {
  type?: string;
  amount?: string | number;
  categoryId?: string | null;
  description?: string | null;
  date?: Date;
}

function applyData(row: StoredTransaction, data: TransactionData): void {
  if (data.type !== undefined) {
    row.type = data.type;
  }
  if (data.amount !== undefined) {
    row.amount = new Prisma.Decimal(String(data.amount));
  }
  if (data.categoryId !== undefined) {
    row.categoryId = data.categoryId;
  }
  if (data.description !== undefined) {
    row.description = data.description;
  }
  if (data.date !== undefined) {
    row.date = data.date;
  }
}

const transaction = {
  findMany({ where, select, orderBy, skip = 0, take }: TransactionFindArgs): Promise<Row[]> {
    const rows = sortRows(filterRows(store.transactions, where), orderBy);
    const page = take === undefined ? rows.slice(skip) : rows.slice(skip, skip + take);

    return Promise.resolve(page.map((row) => projectTransaction(row, select)));
  },

  findFirst({ where, select }: TransactionFindArgs): Promise<Row | null> {
    const row = filterRows(store.transactions, where)[0];

    return Promise.resolve(row === undefined ? null : projectTransaction(row, select));
  },

  count({ where }: TransactionFindArgs): Promise<number> {
    return Promise.resolve(filterRows(store.transactions, where).length);
  },

  /** Sums are produced by the store, never by the service (R-D3). */
  groupBy(args: { by: string[]; where?: Row }): Promise<Row[]> {
    if (args.by.length !== 1 || args.by[0] !== 'type') {
      throw new Error('db-double: groupBy only models `by: ["type"]`');
    }

    const sums = new Map<string, Prisma.Decimal>();

    for (const row of filterRows(store.transactions, args.where)) {
      sums.set(row.type, (sums.get(row.type) ?? new Prisma.Decimal(0)).plus(row.amount));
    }

    return Promise.resolve([...sums].map(([type, amount]) => ({ type, _sum: { amount } })));
  },

  create(args: { data: TransactionData & { userId: string }; select?: Select }): Promise<Row> {
    const row: StoredTransaction = {
      id: nextId('txn'),
      userId: args.data.userId,
      type: '',
      amount: new Prisma.Decimal(0),
      categoryId: null,
      description: null,
      date: new Date(0),
      createdAt: new Date(),
    };

    applyData(row, args.data);
    store.transactions.push(row);

    return Promise.resolve(projectTransaction(row, args.select));
  },

  update(args: { where: Row; data: TransactionData; select?: Select }): Promise<Row> {
    const row = filterRows(store.transactions, args.where)[0];

    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to update not found'));
    }

    applyData(row, args.data);

    return Promise.resolve(projectTransaction(row, args.select));
  },

  deleteMany({ where }: TransactionFindArgs): Promise<{ count: number }> {
    const doomed = new Set(filterRows(store.transactions, where).map((row) => row.id));

    store.transactions = store.transactions.filter((row) => !doomed.has(row.id));

    return Promise.resolve({ count: doomed.size });
  },
};

const budget = {
  count({ where }: { where?: Row }): Promise<number> {
    return Promise.resolve(filterRows(store.budgets, where).length);
  },
};

/**
 * Both `$transaction` forms the services use: the batch array, and the interactive callback that
 * receives a client. Isolation is not modelled — a single-threaded store cannot interleave.
 */
function runTransaction(argument: unknown): Promise<unknown> {
  if (Array.isArray(argument)) {
    return Promise.all(argument as unknown[]);
  }

  if (typeof argument === 'function') {
    return (argument as (tx: unknown) => Promise<unknown>)(prismaDouble);
  }

  throw new Error('db-double: unsupported $transaction argument');
}

export const prismaDouble = { category, transaction, budget, $transaction: runTransaction };
