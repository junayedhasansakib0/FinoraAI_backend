import { MAX_CATEGORIES_PER_USER } from '../../config/constants.js';
import { AppError } from '../../lib/app-error.js';
import { isUniqueViolation } from '../../lib/prisma-errors.js';
import { prisma } from '../../lib/prisma.js';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './categories.validation.js';

/** All business rules for `/categories` (ARCHITECTURE.md §6/§7). */

const CATEGORY_SELECT = {
  id: true,
  name: true,
  type: true,
  isDefault: true,
} as const;

export interface PublicCategory {
  id: string;
  name: string;
  /** `"income" | "expense"` — the column is a plain String (ARCHITECTURE.md §5). */
  type: string;
  /** True for the rows copied from the starter catalog at signup. */
  isDefault: boolean;
}

function duplicateName(type: string): AppError {
  return new AppError('CONFLICT', `You already have another ${type} category with that name.`);
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Category not found.');
}

/** Expense categories first, then income, alphabetical inside each group. */
export async function listCategories(
  userId: string,
  { type }: ListCategoriesQuery,
): Promise<PublicCategory[]> {
  return prisma.category.findMany({
    where: { userId, ...(type === undefined ? {} : { type }) },
    select: CATEGORY_SELECT,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
}

/**
 * The `(userId, name, type)` unique index does the duplicate check, so two concurrent creates
 * cannot both win; P2002 becomes the 409 the contract promises (R-D6).
 */
export async function createCategory(
  userId: string,
  { name, type }: CreateCategoryInput,
): Promise<PublicCategory> {
  const owned = await prisma.category.count({ where: { userId } });

  if (owned >= MAX_CATEGORIES_PER_USER) {
    throw new AppError(
      'CONFLICT',
      `You have reached the limit of ${String(MAX_CATEGORIES_PER_USER)} categories.`,
    );
  }

  try {
    return await prisma.category.create({
      data: { userId, name, type },
      select: CATEGORY_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw duplicateName(type);
    }
    throw error;
  }
}

/**
 * Scoped by `userId` in the same query as the id, so another user's category is a 404 and never
 * a 403 (R-A7, R-D4). Default categories are renamable: the flag only marks their origin.
 */
export async function renameCategory(
  userId: string,
  id: string,
  { name }: UpdateCategoryInput,
): Promise<PublicCategory> {
  const category = await prisma.category.findFirst({
    where: { id, userId },
    select: { type: true },
  });

  if (!category) {
    throw notFound();
  }

  try {
    return await prisma.category.update({
      where: { id },
      data: { name },
      select: CATEGORY_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw duplicateName(category.type);
    }
    throw error;
  }
}

/**
 * R-D7: transactions keep their history because the foreign key is `SetNull`, while a category
 * a budget still points at cannot be removed at all — that budget would silently change scope.
 * The check and the delete share one transaction so a budget cannot appear in between (R-D5).
 */
export async function deleteCategory(userId: string, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const category = await tx.category.findFirst({ where: { id, userId }, select: { id: true } });

    if (!category) {
      throw notFound();
    }

    const budgetsUsingCategory = await tx.budget.count({ where: { userId, categoryId: id } });

    if (budgetsUsingCategory > 0) {
      throw new AppError(
        'CONFLICT',
        'A budget still uses this category. Delete that budget first, then remove the category.',
      );
    }

    await tx.category.delete({ where: { id } });
  });
}
