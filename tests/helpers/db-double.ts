import { Prisma } from '../../src/generated/prisma/client.js';

/**
 * In-memory stand-in for the Prisma singleton, shared by the categories, transactions and
 * dashboard suites. R-T2 rules out the hosted database and this machine has no disposable
 * Postgres, so the double implements exactly the queries those services issue — nothing more.
 * Anything unsupported throws instead of quietly returning a wrong answer, so a service that
 * starts using a new operator fails the suite rather than passing on a lie.
 */

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence)}`;
}

/** Only the profile fields a service reads: month boundaries follow the timezone (D9), and the AI
 *  context reports figures in the user's base currency. */
export interface StoredUser {
  id: string;
  timezone: string;
  currency: string;
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
  amount: Prisma.Decimal;
  month: number;
  year: number;
}

export interface StoredSavingsGoal {
  id: string;
  userId: string;
  name: string;
  targetAmount: Prisma.Decimal;
  currentAmount: Prisma.Decimal;
  deadline: Date;
}

/** A persisted AI report (R-I7). `content` holds the `{ data, scope }` the reports service stores. */
export interface StoredAIReport {
  id: string;
  userId: string;
  type: string;
  content: unknown;
  createdAt: Date;
}

export const store = {
  users: [] as StoredUser[],
  categories: [] as StoredCategory[],
  transactions: [] as StoredTransaction[],
  budgets: [] as StoredBudget[],
  savingsGoals: [] as StoredSavingsGoal[],
  aiReports: [] as StoredAIReport[],
};

export function resetStore(): void {
  store.users = [];
  store.categories = [];
  store.transactions = [];
  store.budgets = [];
  store.savingsGoals = [];
  store.aiReports = [];
  sequence = 0;
}

/** Fixed timestamp so ordering in the fixtures depends only on the fields under test. */
const SEEDED_AT = new Date('2026-01-01T00:00:00.000Z');

/** The id is given rather than generated: it has to match the id the test's token carries. */
export function seedUser(input: { id: string; timezone?: string; currency?: string }): StoredUser {
  const row: StoredUser = {
    id: input.id,
    timezone: input.timezone ?? 'UTC',
    currency: input.currency ?? 'USD',
  };
  store.users.push(row);
  return row;
}

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

/**
 * `amount`, `month` and `year` matter only where a budget is being read as money. Left out, the
 * row lands on month 0 of year 0, which no real lookup can match — so a budget seeded merely to
 * block a category delete cannot also pass for someone's overall budget.
 */
export function seedBudget(input: {
  userId: string;
  categoryId: string | null;
  amount?: string;
  month?: number;
  year?: number;
}): StoredBudget {
  const row: StoredBudget = {
    id: nextId('bud'),
    userId: input.userId,
    categoryId: input.categoryId,
    amount: new Prisma.Decimal(input.amount ?? 0),
    month: input.month ?? 0,
    year: input.year ?? 0,
  };
  store.budgets.push(row);
  return row;
}

/**
 * `name` and `deadline` are optional so the dashboard suite — which only sums `targetAmount` and
 * `currentAmount` — keeps seeding goals with two fields. A goal seeded for the goals suite passes
 * both, since its deadline reckoning depends on them.
 */
export function seedSavingsGoal(input: {
  userId: string;
  targetAmount: string;
  currentAmount: string;
  name?: string;
  deadline?: string;
}): StoredSavingsGoal {
  const row: StoredSavingsGoal = {
    id: nextId('goal'),
    userId: input.userId,
    name: input.name ?? 'Goal',
    targetAmount: new Prisma.Decimal(input.targetAmount),
    currentAmount: new Prisma.Decimal(input.currentAmount),
    deadline: new Date(input.deadline ?? '2099-12-31T23:59:59.999Z'),
  };
  store.savingsGoals.push(row);
  return row;
}

/**
 * A stored AI report (R-I7). `createdAt` is explicit so a test can place a report inside or outside
 * the 24h reuse window; it defaults to the shared seed instant like the other fixtures.
 */
export function seedAIReport(input: {
  userId: string;
  type: string;
  content: unknown;
  createdAt?: Date;
}): StoredAIReport {
  const row: StoredAIReport = {
    id: nextId('report'),
    userId: input.userId,
    type: input.type,
    content: input.content,
    createdAt: input.createdAt ?? SEEDED_AT,
  };
  store.aiReports.push(row);
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
        case 'lt':
          return compareValues(value, operand) < 0;
        case 'in':
          return (
            Array.isArray(operand) &&
            operand.some((candidate: unknown) => compareValues(value, candidate) === 0)
          );
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
    const [field] = args.by;

    if (args.by.length !== 1 || (field !== 'type' && field !== 'categoryId')) {
      throw new Error('db-double: groupBy models only `by: ["type"]` and `by: ["categoryId"]`');
    }

    const sums = new Map<string | null, Prisma.Decimal>();

    for (const row of filterRows(store.transactions, args.where)) {
      const key = field === 'type' ? row.type : row.categoryId;

      sums.set(key, (sums.get(key) ?? new Prisma.Decimal(0)).plus(row.amount));
    }

    return Promise.resolve([...sums].map(([key, amount]) => ({ [field]: key, _sum: { amount } })));
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

  aggregate(args: {
    where?: Row;
    _sum?: Record<string, boolean>;
    _count?: { _all?: boolean };
  }): Promise<Row> {
    const rows = filterRows(store.transactions, args.where);
    const sums: Row = {};

    for (const field of Object.keys(args._sum ?? {})) {
      let total = new Prisma.Decimal(0);

      for (const row of rows) {
        const value = fieldOf(row, field);

        if (!(value instanceof Prisma.Decimal)) {
          throw new Error(`db-double: cannot sum transaction field "${field}"`);
        }

        total = total.plus(value);
      }

      sums[field] = rows.length === 0 ? null : total;
    }

    return Promise.resolve({ _sum: sums, _count: { _all: rows.length } });
  },
};

interface ReadArgs {
  where?: Row;
  select?: Record<string, boolean>;
}

function firstOrNull<T extends object>(
  rows: T[],
  select: Record<string, boolean> | undefined,
): Row | null {
  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  // The same cast `fieldOf` makes: a stored row is a plain object, whatever its interface calls it.
  return select === undefined ? { ...(row as Row) } : projectFields(row, select);
}

const user = {
  findUnique({ where, select }: ReadArgs): Promise<Row | null> {
    return Promise.resolve(firstOrNull(filterRows(store.users, where), select));
  },
};

interface CategoryRelationSpec {
  select?: Record<string, boolean>;
}

interface BudgetSelectSpec {
  select?: Select;
  include?: { category?: boolean | CategoryRelationSpec };
}

function projectBudget(row: StoredBudget, spec: BudgetSelectSpec | undefined): Row {
  const result: Row = { ...row };
  const include = spec?.include;
  const select = spec?.select;

  if (include?.category) {
    const categorySpec = include.category;
    const related = store.categories.find((category) => category.id === row.categoryId);
    const selectFields = typeof categorySpec === 'object' ? categorySpec.select : undefined;
    result.category =
      related === undefined
        ? null
        : selectFields
          ? projectFields(related, selectFields)
          : { ...related };
  }

  if (select) {
    const projection: Row = {};
    for (const [field, val] of Object.entries(select)) {
      if (val === true) {
        projection[field] = fieldOf(row, field);
      } else if (field === 'category' && val !== false) {
        const related = store.categories.find((category) => category.id === row.categoryId);
        const selectFields = typeof val === 'object' ? val.select : undefined;
        projection.category =
          related === undefined
            ? null
            : selectFields
              ? projectFields(related, selectFields)
              : { ...related };
      }
    }
    return projection;
  }

  return result;
}

interface BudgetFindArgs {
  where?: Row;
  select?: Select;
  include?: { category?: boolean | CategoryRelationSpec };
  orderBy?: OrderBy[];
}

const budget = {
  count({ where }: ReadArgs): Promise<number> {
    return Promise.resolve(filterRows(store.budgets, where).length);
  },

  findFirst({ where, select, include }: BudgetFindArgs = {}): Promise<Row | null> {
    const row = filterRows(store.budgets, where)[0];
    return Promise.resolve(row === undefined ? null : projectBudget(row, { select, include }));
  },

  findMany({ where, select, include, orderBy }: BudgetFindArgs = {}): Promise<Row[]> {
    const rows = sortRows(filterRows(store.budgets, where), orderBy);
    return Promise.resolve(rows.map((row) => projectBudget(row, { select, include })));
  },

  create(args: {
    data: {
      userId: string;
      categoryId: string | null;
      amount: Prisma.Decimal;
      month: number;
      year: number;
    };
    select?: Select;
    include?: { category?: boolean | CategoryRelationSpec };
  }): Promise<Row> {
    const row: StoredBudget = {
      id: nextId('bud'),
      userId: args.data.userId,
      categoryId: args.data.categoryId ?? null,
      amount: args.data.amount,
      month: args.data.month,
      year: args.data.year,
    };
    store.budgets.push(row);
    return Promise.resolve(projectBudget(row, { select: args.select, include: args.include }));
  },

  update(args: {
    where: Row;
    data: { amount?: Prisma.Decimal };
    select?: Select;
    include?: { category?: boolean | CategoryRelationSpec };
  }): Promise<Row> {
    const row = filterRows(store.budgets, args.where)[0];
    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to update not found'));
    }
    if (args.data.amount !== undefined) {
      row.amount = args.data.amount;
    }
    return Promise.resolve(projectBudget(row, { select: args.select, include: args.include }));
  },

  delete(args: { where: Row }): Promise<Row> {
    const row = filterRows(store.budgets, args.where)[0];
    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to delete does not exist'));
    }
    store.budgets = store.budgets.filter((b) => b.id !== row.id);
    return Promise.resolve({ ...row });
  },
};

interface SavingsGoalFindArgs {
  where?: Row;
  select?: Record<string, boolean>;
  orderBy?: OrderBy[];
}

interface SavingsGoalData {
  userId?: string;
  name?: string;
  targetAmount?: Prisma.Decimal;
  currentAmount?: Prisma.Decimal;
  deadline?: Date;
}

function projectSavingsGoal(
  row: StoredSavingsGoal,
  select: Record<string, boolean> | undefined,
): Row {
  return select === undefined ? { ...row } : projectFields(row, select);
}

const savingsGoal = {
  /** `_sum` of nothing is null in Postgres, and Prisma passes that through — so the double does. */
  aggregate(args: {
    where?: Row;
    _sum?: Record<string, boolean>;
    _count?: { _all?: boolean };
  }): Promise<Row> {
    const rows = filterRows(store.savingsGoals, args.where);
    const sums: Row = {};

    for (const field of Object.keys(args._sum ?? {})) {
      let total = new Prisma.Decimal(0);

      for (const row of rows) {
        const value = fieldOf(row, field);

        if (!(value instanceof Prisma.Decimal)) {
          throw new Error(`db-double: cannot sum savings goal field "${field}"`);
        }

        total = total.plus(value);
      }

      sums[field] = rows.length === 0 ? null : total;
    }

    return Promise.resolve({ _sum: sums, _count: { _all: rows.length } });
  },

  findMany({ where, select, orderBy }: SavingsGoalFindArgs = {}): Promise<Row[]> {
    const rows = sortRows(filterRows(store.savingsGoals, where), orderBy);

    return Promise.resolve(rows.map((row) => projectSavingsGoal(row, select)));
  },

  findFirst({ where, select }: SavingsGoalFindArgs = {}): Promise<Row | null> {
    const row = filterRows(store.savingsGoals, where)[0];

    return Promise.resolve(row === undefined ? null : projectSavingsGoal(row, select));
  },

  create(args: {
    data: SavingsGoalData & { userId: string; name: string; deadline: Date };
    select?: Record<string, boolean>;
  }): Promise<Row> {
    const row: StoredSavingsGoal = {
      id: nextId('goal'),
      userId: args.data.userId,
      name: args.data.name,
      targetAmount: args.data.targetAmount ?? new Prisma.Decimal(0),
      currentAmount: args.data.currentAmount ?? new Prisma.Decimal(0),
      deadline: args.data.deadline,
    };
    store.savingsGoals.push(row);

    return Promise.resolve(projectSavingsGoal(row, args.select));
  },

  update(args: {
    where: Row;
    data: SavingsGoalData;
    select?: Record<string, boolean>;
  }): Promise<Row> {
    const row = filterRows(store.savingsGoals, args.where)[0];

    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to update not found'));
    }

    if (args.data.name !== undefined) {
      row.name = args.data.name;
    }
    if (args.data.targetAmount !== undefined) {
      row.targetAmount = args.data.targetAmount;
    }
    if (args.data.currentAmount !== undefined) {
      row.currentAmount = args.data.currentAmount;
    }
    if (args.data.deadline !== undefined) {
      row.deadline = args.data.deadline;
    }

    return Promise.resolve(projectSavingsGoal(row, args.select));
  },

  delete(args: { where: Row }): Promise<Row> {
    const row = filterRows(store.savingsGoals, args.where)[0];

    if (row === undefined) {
      return Promise.reject(knownRequestError('P2025', 'Record to delete does not exist'));
    }

    store.savingsGoals = store.savingsGoals.filter((candidate) => candidate.id !== row.id);

    return Promise.resolve({ ...row });
  },
};

interface AIReportFindArgs {
  where?: Row;
  orderBy?: OrderBy[];
  take?: number;
}

const aiReport = {
  findMany({ where, orderBy, take }: AIReportFindArgs = {}): Promise<Row[]> {
    const rows = sortRows(filterRows(store.aiReports, where), orderBy);
    const page = take === undefined ? rows : rows.slice(0, take);

    return Promise.resolve(page.map((row) => ({ ...row })));
  },

  findFirst({ where, orderBy }: AIReportFindArgs = {}): Promise<Row | null> {
    const row = sortRows(filterRows(store.aiReports, where), orderBy)[0];

    return Promise.resolve(row === undefined ? null : { ...row });
  },

  create(args: { data: { userId: string; type: string; content: unknown } }): Promise<Row> {
    const row: StoredAIReport = {
      id: nextId('report'),
      userId: args.data.userId,
      type: args.data.type,
      content: args.data.content,
      createdAt: new Date(),
    };
    store.aiReports.push(row);

    return Promise.resolve({ ...row });
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

export const prismaDouble = {
  user,
  category,
  transaction,
  budget,
  savingsGoal,
  aIReport: aiReport,
  $transaction: runTransaction,
};
