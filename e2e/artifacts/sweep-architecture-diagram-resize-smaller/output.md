# System Architecture





    ┌─────────────┐   ┌─────────────┐   ┌─────────────────┐
    │  API GW     │   │  API GW     │   │  API GW         │
    │  (primary)  │   │  (replica)  │   │  (replica)      │
    └─────────────┘   └─────────────┘   └─────────────────┘

    ┌──────────────────────────────────────────────────────┐
    │                    Message Bus (Kafka)               │
    └──────────────────────────────────────────────────────┘

  ┌─────────┐ ┌───────┐ ┌────────┐ ┌─────────┐
  │ Auth    │ │ Users │ │ Orders │ │ Payment │
  │ Service │ │ Svc   │ │ Svc    │ │ Svc     │
  └─────────┘ └───────┘ └────────┘ └─────────┘



           │                  │                   │
           │                  │                   │
                                                            │
       │          │          │          │

Each service owns its database. Communication via async events.