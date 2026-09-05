/**
 * The system catalog of starter categories. ARCHITECTURE.md §5 has no user-independent
 * category table, so the catalog lives here as a constant and is copied into
 * `Category` rows for each new user at signup (PROJECT_CONTEXT.md §4).
 */

export const TRANSACTION_TYPES = ['income', 'expense'] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Housing',
  'Utilities',
  'Health',
  'Entertainment',
  'Shopping',
  'Education',
  'Other',
] as const;

export const DEFAULT_INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
  'Investments',
  'Gifts',
  'Other',
] as const;

export interface CatalogCategory {
  name: string;
  type: TransactionType;
}

/** Flat list in insertion order. */
export const DEFAULT_CATEGORY_CATALOG: readonly CatalogCategory[] = [
  ...DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ name, type: 'expense' as const })),
  ...DEFAULT_INCOME_CATEGORIES.map((name) => ({ name, type: 'income' as const })),
];

/**
 * Category rows for a new account. `isDefault` marks them as catalog-seeded so the UI can
 * tell them apart from categories the user created.
 */
export function catalogCategoryRows(): Array<{
  name: string;
  type: TransactionType;
  isDefault: true;
}> {
  return DEFAULT_CATEGORY_CATALOG.map(({ name, type }) => ({ name, type, isDefault: true }));
}
