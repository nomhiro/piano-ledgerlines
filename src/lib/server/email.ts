import { EmailClient, KnownEmailSendStatus, type EmailAddress, type EmailMessage as AzureEmailMessage } from "@azure/communication-email";
import { getConfig, type EmailBackend } from "./config";
import { createAzureCredential } from "./azure-credential";

export interface EmailRecipient {
  address: string;
  displayName?: string;
}

export interface EmailMessage {
  to: string | EmailRecipient[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: EmailRecipient[];
}

export type EmailSendRequest = EmailMessage;

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

function recipients(message: EmailMessage): EmailRecipient[] {
  return typeof message.to === "string" ? [{ address: message.to }] : message.to;
}

function validateRequest(message: EmailMessage): void {
  const to = recipients(message);
  if (!to.length || to.some((recipient) => !recipient.address.trim())) {
    throw new Error("Email recipient is required");
  }
  if (!message.subject.trim() || !message.text.trim()) {
    throw new Error("Email subject and plain-text body are required");
  }
}

function requiredEmailConfig(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export class InMemoryEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    validateRequest(message);
    this.messages.push(structuredClone(message));
  }
}

/** Development-only sender that never contacts an external service or logs message content. */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    validateRequest(message);
    console.info(JSON.stringify({
      name: "email.send.suppressed",
      recipientCount: recipients(message).length,
      hasHtml: Boolean(message.html),
    }));
  }
}

type EmailClientLike = Pick<EmailClient, "beginSend">;

export class AzureEmailSender implements EmailSender {
  private readonly client: EmailClientLike;
  private readonly senderAddress: string;

  constructor(client?: EmailClientLike, senderAddress?: string) {
    if (client) {
      this.client = client;
      this.senderAddress = senderAddress ?? requiredEmailConfig(
        "AZURE_COMMUNICATION_EMAIL_SENDER_ADDRESS",
        getConfig().azureCommunicationEmailSenderAddress,
      );
      return;
    }

    const config = getConfig();
    this.client = new EmailClient(
      requiredEmailConfig("AZURE_COMMUNICATION_EMAIL_ENDPOINT", config.azureCommunicationEmailEndpoint),
      createAzureCredential(),
    );
    this.senderAddress = requiredEmailConfig(
      "AZURE_COMMUNICATION_EMAIL_SENDER_ADDRESS",
      config.azureCommunicationEmailSenderAddress,
    );
  }

  async send(messageRequest: EmailMessage): Promise<void> {
    validateRequest(messageRequest);
    const to = recipients(messageRequest);
    const message: AzureEmailMessage = {
      senderAddress: this.senderAddress,
      content: {
        subject: messageRequest.subject,
        plainText: messageRequest.text,
        ...(messageRequest.html ? { html: messageRequest.html } : {}),
      },
      recipients: {
        to: to.map(toAzureAddress),
      },
      ...(messageRequest.replyTo?.length ? { replyTo: messageRequest.replyTo.map(toAzureAddress) } : {}),
    };

    const poller = await this.client.beginSend(message);
    const result = await poller.pollUntilDone();
    if (result.status !== KnownEmailSendStatus.Succeeded) {
      throw new Error("Azure Communication Services email operation failed");
    }
  }
}

function toAzureAddress(recipient: EmailRecipient): EmailAddress {
  return {
    address: recipient.address,
    ...(recipient.displayName ? { displayName: recipient.displayName } : {}),
  };
}

export function createEmailSender(backend?: EmailBackend): EmailSender {
  const config = getConfig();
  const selectedBackend = backend ?? config.emailBackend;
  if (config.nodeEnv === "production" && selectedBackend !== "azure") {
    throw new Error("Production email delivery must use Azure Communication Services");
  }
  switch (selectedBackend) {
    case "azure":
      return new AzureEmailSender();
    case "console":
      return new ConsoleEmailSender();
    case "memory":
      return new InMemoryEmailSender();
  }
}

let sender: EmailSender | undefined;

export function getEmailSender(): EmailSender {
  sender ??= createEmailSender();
  return sender;
}

export function resetEmailSenderForTests(): void {
  sender = undefined;
}
