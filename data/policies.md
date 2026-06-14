# Payment Issue Resolution Policies

This document describes how payment issues should be handled. Use these policies to determine whether an issue can be auto-resolved, needs human review, or should be escalated.

---

## Declined Payments

### Insufficient Funds

When a payment fails due to insufficient funds:

- **Auto-retry**: Up to 3 attempts total
- **Retry timing**: Wait 2 days between retries
- **Customer notification**: Send after the second failed attempt
- **Escalate when**: Third retry fails, or customer contacts support
- **Can auto-resolve**: No — requires either successful retry or human decision

### Expired Card

When a payment fails due to an expired card:

- **Auto-retry**: No — retrying won't help
- **Customer notification**: Immediately request updated payment method
- **Escalate when**: No response after 48 hours AND it's a recurring subscription
- **Can auto-resolve**: No — customer must provide new payment method

---

## Missed Installments

When a customer misses an installment payment:

- **Grace period**: 7 days before escalation
- **Auto-reminders**: Send on day 1 and day 5 after missed payment
- **Resolution options**: Retry payment, modify plan schedule, or pause plan
- **Escalate when**: More than 7 days overdue OR customer has missed payments on multiple plans
- **Can auto-resolve**: Yes, if ALL of these are true:
  - 3 or fewer days overdue
  - Customer has "low" risk score
  - Retry payment succeeds

---

## Disputes

### Item Not Received

When a customer claims they didn't receive their order:

- **Auto-resolve when**: Tracking shows "delivered" AND it's been 3+ days since delivery
- **Escalate when**: Any of these are true:
  - Dispute amount exceeds $200
  - Customer is high-value (lifetime spend > $2000)
  - Merchant has history of fulfillment issues
- **Required context**: Tracking info, delivery confirmation, customer communication history
- **Can auto-resolve**: Only if tracking confirms delivery and no escalation triggers apply

### Unauthorized Transaction

When a customer claims they didn't make the purchase:

- **Auto-resolve**: Never — fraud claims always need human review
- **Escalate**: Always, immediately
- **Priority**: High
- **Required context**: Device fingerprint, IP address, purchase patterns

---

## Refund Requests

### Changed Mind / Buyer's Remorse

When a customer wants a refund because they changed their mind:

- **Eligible window**: 14 days from purchase
- **Auto-resolve when**: Within 14 days AND item hasn't shipped yet
- **Escalate when**: Item has shipped OR more than 14 days since purchase
- **Installment plans**: Refund only paid installments; cancel remaining
- **Can auto-resolve**: Yes, if within window and item not yet shipped

---

## General Guidelines

1. **When in doubt, escalate.** A human reviewing a borderline case costs less than a wrong automated decision.

2. **High-value customers get extra care.** Even if a case could be auto-resolved, consider escalating for customers with lifetime spend > $2000.

3. **Document everything.** Every decision—automated or human—must be logged with reasoning.

4. **Speed matters, but accuracy matters more.** A fast wrong decision costs more than a slightly slower correct one.
