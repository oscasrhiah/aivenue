# 1. Payments go through a port

Status: accepted

Order code must not call the payment SDK directly. It calls a `PaymentPort` interface, so the provider can be
swapped and order logic tested without a network.
