import Stripe from "stripe";
import { ConfigurationError } from "./http";
import { getConfig } from "./config";

function assertServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new ConfigurationError("Stripe billing is server-only");
  }
}

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  classroomBasePriceId: string;
  classroomStudentPriceId: string;
  appBaseUrl: string;
}

export function getStripeBillingConfig(): StripeBillingConfig {
  assertServerRuntime();
  const config = getConfig();
  const values = {
    secretKey: config.stripeSecretKey,
    webhookSecret: config.stripeWebhookSecret,
    classroomBasePriceId: config.stripeClassroomBasePriceId,
    classroomStudentPriceId: config.stripeClassroomStudentPriceId,
    appBaseUrl: config.ledgerlinesAppBaseUrl,
  };
  if (Object.values(values).some((value) => !value)) {
    throw new ConfigurationError();
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(values.appBaseUrl!);
  } catch {
    throw new ConfigurationError();
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.hash ||
    (getConfig().nodeEnv === "production" && baseUrl.protocol !== "https:")
  ) {
    throw new ConfigurationError();
  }

  return {
    secretKey: values.secretKey!,
    webhookSecret: values.webhookSecret!,
    classroomBasePriceId: values.classroomBasePriceId!,
    classroomStudentPriceId: values.classroomStudentPriceId!,
    appBaseUrl: baseUrl.toString().replace(/\/$/, ""),
  };
}

export interface StripeGateway {
  createCustomer(
    params: Stripe.CustomerCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Customer>;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Checkout.Session>;
  createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.BillingPortal.Session>;
  retrieveSubscription(
    subscriptionId: string,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription>;
  listCustomerSubscriptions(
    customerId: string,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription[]>;
  createSubscriptionItem(
    params: Stripe.SubscriptionItemCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.SubscriptionItem>;
  updateSubscriptionItem(
    itemId: string,
    params: Stripe.SubscriptionItemUpdateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.SubscriptionItem>;
  deleteSubscriptionItem(
    itemId: string,
    params: Stripe.SubscriptionItemDeleteParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.DeletedSubscriptionItem>;
  constructWebhookEvent(rawBody: string, signature: string, secret: string): Stripe.Event;
}

export class StripeGatewayClient implements StripeGateway {
  private readonly stripe: Stripe;

  constructor(client?: Stripe) {
    assertServerRuntime();
    this.stripe = client ?? new Stripe(getStripeBillingConfig().secretKey);
  }

  async createCustomer(
    params: Stripe.CustomerCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Customer> {
    return this.stripe.customers.create(params, options);
  }

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.create(params, options);
  }

  async createBillingPortalSession(
    params: Stripe.BillingPortal.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.stripe.billingPortal.sessions.create(params, options);
  }

  async retrieveSubscription(
    subscriptionId: string,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId, undefined, options);
  }

  async listCustomerSubscriptions(
    customerId: string,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription[]> {
    const response = await this.stripe.subscriptions.list(
      { customer: customerId, status: "all", limit: 100 },
      options,
    );
    return response.data;
  }

  async createSubscriptionItem(
    params: Stripe.SubscriptionItemCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.SubscriptionItem> {
    return this.stripe.subscriptionItems.create(params, options);
  }

  async updateSubscriptionItem(
    itemId: string,
    params: Stripe.SubscriptionItemUpdateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.SubscriptionItem> {
    return this.stripe.subscriptionItems.update(itemId, params, options);
  }

  async deleteSubscriptionItem(
    itemId: string,
    params: Stripe.SubscriptionItemDeleteParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.DeletedSubscriptionItem> {
    return this.stripe.subscriptionItems.del(itemId, params, options);
  }

  constructWebhookEvent(rawBody: string, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}

let gateway: StripeGateway | undefined;

export function getStripeGateway(): StripeGateway {
  gateway ??= new StripeGatewayClient();
  return gateway;
}

export function resetStripeGatewayForTests(): void {
  gateway = undefined;
}

export function buildBillingUrl(baseUrl: string, path: string, classroomId: string): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("classroomId", classroomId);
  return url.toString();
}
