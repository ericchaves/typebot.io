import { TRPCError } from "@trpc/server";
import { env } from "@typebot.io/env";
import prisma from "@typebot.io/prisma";
import type { User } from "@typebot.io/user/schemas";
import { isAdminWriteWorkspaceForbidden } from "@typebot.io/workspaces/isAdminWriteWorkspaceForbidden";
import Stripe from "stripe";
import { createCheckoutSessionUrl } from "../helpers/createCheckoutSessionUrl";

type Props = {
  workspaceId: string;
  user: Pick<User, "email" | "id">;
  returnUrl: string;
  email: string;
  company: string;
  plan: "STARTER" | "PRO";
  vat?: {
    type: string;
    value: string;
  };
};

export const createCheckoutSession = async ({
  workspaceId,
  user,
  returnUrl,
  email,
  company,
  plan,
  vat,
}: Props) => {
  if (!env.STRIPE_SECRET_KEY)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe environment variables are missing",
    });
  const workspace = await prisma.workspace.findFirst({
    where: {
      id: workspaceId,
    },
    select: {
      stripeId: true,
      members: {
        select: {
          userId: true,
          role: true,
        },
      },
    },
  });

  if (!workspace || isAdminWriteWorkspaceForbidden(workspace, user))
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  if (workspace.stripeId)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Customer already exists, use updateSubscription endpoint.",
    });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-09-30.acacia",
  });

  await prisma.user.updateMany({
    where: {
      id: user.id,
    },
    data: {
      company,
    },
  });

  const customer = await stripe.customers.create({
    email,
    name: company,
    metadata: { workspaceId },
    tax_exempt:
      !vat || vat.value.startsWith("FR") || vat?.type !== "eu_vat"
        ? undefined
        : "exempt",
    tax_id_data: vat
      ? [vat as Stripe.CustomerCreateParams.TaxIdDatum]
      : undefined,
  });

  const checkoutUrl = await createCheckoutSessionUrl(stripe)({
    customerId: customer.id,
    userId: user.id,
    workspaceId,
    plan,
    returnUrl,
  });

  if (!checkoutUrl)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stripe checkout session creation failed",
    });

  return {
    checkoutUrl,
  };
};
