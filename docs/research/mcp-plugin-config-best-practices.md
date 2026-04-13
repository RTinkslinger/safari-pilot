# Executive Summary

Effective management of Claude Code MCP plugin configuration hinges on a hybrid approach that balances security, flexibility, and user experience. Best practices advocate for a clear separation between hardcoded, security-critical defaults (e.g., protocol versions, compliance rules) and user-configurable settings (e.g., API endpoints, performance knobs, domain policies). The recommended storage model is layered: use version-controlled project-level files like `settings.json` for team-shared, reproducible configurations; use git-ignored `.env` files for local development and secrets; and leverage global settings for user-specific preferences. Critically, sensitive data such as API keys must never be committed to version control, but instead referenced via environment variables or a secure vault integration.

User interaction should be multi-channel. Declarative JSON/YAML configuration files are essential for auditability and CI/CD pipelines. Discoverable slash commands (e.g., `/config`, `/mcp`) provide a low-friction interface for frequent, repeatable tasks. For more complex or guided setups, conversational AI flows can walk users through configuration, providing summaries and requiring explicit confirmation before applying changes. This is particularly effective for nuanced settings like browser automation rules. The entire system must be built on a foundation of security, employing least-privilege principles, providing secure-by-default options, implementing idempotent lifecycle commands (start/stop/restart), and ensuring all configuration changes are auditable.

# Key Recommendations Checklist

## Recommendation

Declare all plugin components, including commands, agents, and MCP servers, in the `plugin.json` manifest for proper registration and discovery by Claude Code.

## Category

Setup

## Recommendation

Ship a default `settings.json` file at the plugin's root to provide sensible, out-of-the-box configurations for users.

## Category

Setup

## Recommendation

Never commit secrets (API keys, tokens) to version control. Use a `.gitignore` file to exclude `.env`, `*.local.json`, and other sensitive files.

## Category

Security

## Recommendation

Isolate secrets by referencing them via environment variables (e.g., `${API_KEY}`) in config files or by integrating with a dedicated secrets manager like HashiCorp Vault or 1Password.

## Category

Security

## Recommendation

Implement secure-by-default settings: telemetry should be opt-in, rate limits conservative, and permissions based on the principle of least privilege.

## Category

Security

## Recommendation

For sensitive operations, implement an 'Ask vs. Always Allow' permission model, requiring explicit user consent for capabilities that access files or networks.

## Category

Security

## Recommendation

Categorize settings (e.g., Credentials, Endpoints, Policies, Performance) to clearly define which should be user-configurable versus hardcoded for security or stability.

## Category

Design & Scoping

## Recommendation

Use a versioned schema for your configuration files (e.g., `"schemaVersion": "1.1"`) and provide migration scripts or clear documentation for breaking changes.

## Category

Design & Scoping

## Recommendation

Adopt a hierarchical persistence model: use version-controlled project files (`.claude/settings.json`) for team collaboration, and local files (`.claude/settings.local.json`, `.env`) for personal overrides and secrets.

## Category

Persistence & Collaboration

## Recommendation

Support multiple environments (dev, staging, prod) by using environment-specific configuration files or loading secrets dynamically based on an environment flag.

## Category

Persistence & Collaboration

## Recommendation

Enable configuration import/export (e.g., via JSON/YAML) and consider cloud sync to ensure a consistent user experience across multiple devices.

## Category

Persistence & Collaboration

## Recommendation

Employ a hybrid interaction model: use config files for auditable automation, slash commands for discoverable actions, and conversational skills for guided, complex workflows.

## Category

UX & Interaction

## Recommendation

When using conversational configuration, always follow a 'parse -> summarize -> confirm' flow, presenting a human-readable summary and requiring explicit user approval before applying changes.

## Category

UX & Interaction

## Recommendation

Provide a preview or dry-run mode that shows a differential summary of configuration changes, allowing users to see the impact before committing.

## Category

UX & Interaction

## Recommendation

Design idempotent lifecycle commands (start, stop, restart) that can be run multiple times without causing errors, and provide rich status feedback.

## Category

Lifecycle & Resilience

## Recommendation

Implement health and readiness probes (e.g., `/healthz`, `/ready` endpoints) to allow Claude Code's orchestrator to monitor the plugin's status.

## Category

Lifecycle & Resilience

## Recommendation

Ensure robust resource cleanup on stop or failure, including revoking temporary tokens, closing network connections, and deleting temp files.

## Category

Lifecycle & Resilience


# Configuration Design Principles

## Category

Credentials, Endpoints, Policies, Performance Knobs, and Telemetry

## Typical Settings

Typical settings include API keys, authentication tokens, base URLs for MCP servers, webhook URLs, rate-limit thresholds, request-size caps, data-retention policies, timeout values, concurrency limits, cache sizes, and opt-in analytics flags.

## User Configurable Guidance

Users should be able to configure settings that vary between environments or directly affect their experience. This includes credentials like API keys and tokens (which must be stored securely via environment variables or a secrets manager, not in the config file), server endpoint URLs (to allow switching between staging and production), policy limits that impact user experience (such as rate-limit thresholds), performance knobs (like timeouts and cache sizes for project-specific tuning), and telemetry settings (which must be opt-in for privacy).

## Hard Coded Guidance

Developers should hard-code settings that are fundamental to the plugin's stable operation, security posture, or legal compliance. This includes default placeholder values for credentials (e.g., `YOUR_API_KEY`), the core protocol version, required URL path prefixes, mandatory compliance rules (like legal flags or required encryption modes), core internal performance allocations (like thread-pool sizes), and internal health-check endpoints. This approach ensures stability, security, and consistency.


# Setting Scope Guidelines

## Per Project Scope Guidance

Settings should be scoped on a per-project basis when they are integral to the project's reproducibility, continuous integration (CI) pipelines, or involve team-specific credentials and endpoints. This is ideal for endpoint URLs, test-specific API tokens, and performance limits that differ between development and production environments. Storing these settings within the project's repository (e.g., in a `.claude/settings.json` file) ensures that all team members and automated systems use a consistent configuration for that specific project.

## Global Scope Guidance

Global scope, which applies to a user or team across all projects, is best suited for settings that establish consistent defaults or enforce universal policies. This includes secure defaults for handling secrets, a universal opt-out setting for telemetry collection, or mandated compliance policies that must apply to all activities. These settings are typically stored in a user's home directory (e.g., `~/.claude/settings.json`) to provide a consistent baseline experience.

## Hybrid Approach Recommendation

A recommended hybrid approach combines global and project scopes to balance consistency with project-specific flexibility. This model involves storing a minimal baseline of secure, global defaults (e.g., enforcing security best practices or setting a universal telemetry opt-out). Projects can then override non-critical, project-specific settings like endpoint URLs or performance knobs in a version-controlled project file. This allows for team-wide consistency on security and compliance while providing the necessary flexibility for individual projects. Furthermore, local overrides (e.g., in a `.claude/settings.local.json` file, ignored by version control) can be used for personal preferences or to load local secrets without committing them to the repository.


# Secure Defaults And Secrets Management

## Principle

Secure Defaults and Least Privilege

## Description

This core principle dictates that plugins must be secure out-of-the-box, with the most restrictive and safe settings enabled by default. Users should be required to explicitly opt-in to enable riskier capabilities or relax security constraints. For credentials, this means adhering to the principle of least privilege by requesting the narrowest possible permissions by default. This approach minimizes the potential attack surface, prevents accidental data exposure, and ensures users make conscious decisions about security trade-offs.

## Example

A concrete implementation of this principle is to default the telemetry setting to disabled (`telemetry.enabled: false`), requiring users to explicitly opt-in to share usage data. Another example is setting a conservative default rate limit (e.g., `rateLimit.maxRequestsPerMinute: 60`) that a user must explicitly raise. For secrets management, a critical aspect is to never store raw secrets in configuration files. Instead, use environment variable substitution (e.g., `"apiKey": "${BROWSER_API_KEY}"`) which allows the runtime to resolve the secret from a secure location like the host environment, a `.env` file (excluded from version control), or an integrated secrets manager like HashiCorp Vault or 1Password.


# Configuration Interaction Patterns

## Pattern Name

Comparison of Configuration Patterns: Config Files, Slash Commands, and Conversational Skills

## Discoverability

Discoverability varies greatly. Slash commands have 'Very High' discoverability as they are automatically listed via the `/help` command. Conversational skills have 'Low' discoverability, requiring users to know the skill's name. Config files have 'None' as they are not directly surfaced in the UI and must be located in the file system.

## Safety

Config files offer 'High' safety through explicit allow/deny lists. Slash commands provide 'Moderate' safety, contingent on the secure configuration of `allowed-tools` in the command's front-matter. Conversational skills have 'Variable' safety, as their autonomous execution capabilities can be risky without carefully implemented guardrails.

## Auditability

Config files provide 'High' auditability, as they can be version-controlled, diffed, and reviewed. Slash commands offer 'Moderate' auditability since their definitions can be stored in a repository but are less direct to track than file changes. Conversational skills have 'Low' auditability because their underlying markdown files are often not version-controlled.

## Automation Suitability

All three patterns are rated 'High' for automation. Config files are ideal for declarative CI/CD pipelines. Slash commands are easily scriptable and can be chained for procedural automation. Conversational skills excel at enabling complex, agent-driven workflows and rapid prototyping through natural language.

## User Suitability

The patterns cater to different users. Config files are best for power users who need declarative, reproducible setups. Slash commands are excellent for novice users due to their high discoverability and simple UI, while remaining useful for power users. Conversational skills are primarily aimed at power users who can leverage their flexibility for complex automation.


# Recommended Hybrid Interaction Model

## Component

Hybrid Model for Core Configuration, Frequent Actions, and Complex Workflows

## Recommended Method

A combination of Config Files, Slash Commands, and Conversational Skills

## Rationale

The model allocates specific methods to different components: 1. **Core Configuration** (e.g., server endpoints, auth methods, global policies) should use version-controlled **Config Files** to ensure auditability and reproducibility, making it ideal for team-wide policies and CI/CD. 2. **Safe, Frequent Actions** should be exposed as **Slash Commands**, which are highly discoverable and easy for novices to use safely. 3. **Complex, Multi-step Workflows** are best implemented as **Conversational Skills**, providing maximum flexibility for power users and autonomous agents, but they must be secured with strict guardrails and validation hooks.


# Plugin Command Lifecycle Best Practices

## Practice Area

Idempotency and State Management

## Best Practice Summary

Lifecycle commands (start, stop, restart) should be designed to be idempotent, meaning repeated calls have the same effect as a single call. For example, a repeated 'start' command on an already running service should be a no-op. This can be achieved by using explicit state transitions (e.g., STOPPED → STARTING → RUNNING) and employing compare-and-swap or versioned state checks to prevent race conditions. Commands should return operation IDs and provide rich status information, allowing callers to poll for completion and view the final state, timestamps, and any failure reasons.


# Conversational Configuration Design

## Design Principle

Core Principles for Safe and Auditable Conversational Configuration

## Description

A robust conversational configuration system should be founded on several key principles: 1. **Prompt/Flow Patterns**: Employ a structured interaction that includes natural-language intent capture, a summary of the parsed policy for user review, and an explicit confirmation step before applying any changes. 2. **Guardrails**: Implement strict safety mechanisms, such as requiring typed confirmations for high-risk actions, explaining the associated risks, and providing preset safety tiers (e.g., 'Strict', 'Balanced', 'Permissive'). 3. **Preview/Dry-Run Mode**: Before committing changes, offer a preview that simulates the effects of the new policy and provides a differential summary ('diff') highlighting what will be added, removed, or modified. 4. **Conflict Resolution**: Establish a clear precedence order for settings (e.g., ephemeral conversation < project file < organization policy) and provide an interactive flow to resolve conflicts. 5. **Audit Trails**: Maintain an immutable, searchable change history that records the 'who, what, and when' of every modification, ensuring full transparency and accountability.


# Browser Automation Config Ux

## Ux Pattern

Natural Language Policy Configuration

## Description

This pattern allows users to configure complex browser automation settings using natural language prompts. The process involves several steps to ensure safety and clarity: 1) The user states their desired policy in plain language. 2) An AI agent parses the request into a structured policy. 3) The agent presents a concise, human-readable summary of the parsed policy and a differential summary (a 'diff') of what will change. 4) For risky changes, such as enabling full-access scripting, the system requires explicit, typed confirmation from the user after explaining the risks. 5) A 'dry-run' or 'preview' mode is offered to simulate the policy's enforcement and show its impact on sites or tasks before it is applied. 6) The system provides preset templates like 'Strict', 'Balanced', and 'Permissive' to guide users toward safe and common configurations. 7) All changes are recorded in an immutable, searchable audit trail.

## Example

A user could provide a prompt like: "For the domain example.com, limit page navigation to one request per second, but for all other domains, set a rate limit of 20 requests per minute. Also, block all third-party cookies everywhere."


# Settings Persistence Models

## Model Name

Secrets Stores (e.g., OS keychain, 1Password, HashiCorp Vault, CI secret stores)

## Pros

Provides secure, auditable, and centrally manageable storage for sensitive data like tokens and secrets. This is ideal for team environments.

## Cons

Introduces additional infrastructure overhead and complexity in managing access controls.

## Recommended Use Case

Storing sensitive data such as API keys, authentication tokens, and other credentials. Integration should be done at runtime via Plugin SDK secret APIs, environment variable injection from the CI/CD pipeline, or a secrets provider client, rather than storing secrets in version-controlled files.


# Recommended File And Directory Structure

## File Or Directory

.env.example

## Purpose

A template file that defines the required environment variables for the plugin to function, but with placeholder or non-sensitive default values. It serves as documentation for developers and a blueprint for creating their local `.env` file.

## Vcs Status

committed


# Claude Code Plugin Sdk Capabilities

## Capability Area

Manifest and Command Registration

## Summary

The SDK uses a `plugin.json` manifest file as the central point for declaring a plugin's metadata and components. This includes its name, version, and arrays of components such as commands, agents, skills, and hooks. Commands are defined as individual Markdown files located in a `commands/` directory and are then referenced in the `plugin.json` manifest to be registered with the system. The lifecycle of these commands (e.g., their availability in the UI) is managed through CLI commands like `claude plugin enable/disable`. To prevent conflicts, all registered components are automatically namespaced using the plugin's name (e.g., `my-plugin:my-command`).


# Sdk Limitations And Workarounds

## Limitation

The Plugin SDK does not provide a direct API for programmatically updating or hot-reloading plugin settings while the plugin is running. Configuration changes are primarily managed through static files and require a lifecycle event (e.g., disabling and re-enabling the plugin via the CLI) to take effect.

## Recommended Workaround

To enable dynamic configuration, developers can implement custom MCP (Model Configuration Protocol) server endpoints. These endpoints can expose an API that, when called, applies configuration changes to the running plugin instance. This approach allows for runtime updates without needing to restart or reinstall the plugin. Alternatively, hooks can be used to apply configuration changes during specific, predefined lifecycle events.


# Ux Patterns From Browser Extensions

## Ux Pattern

Safe Defaults and Progressive Disclosure

## Observation

Both 1Password and AdGuard's Safari extensions implement this pattern effectively. They start with safe, least-privilege defaults; for instance, 1Password requires user confirmation before granting 'Always Allow' access to fill passwords on a site, and AdGuard defaults to enabled protection but offers an 'Ask' option for per-site permissions rather than allowing access everywhere. Advanced or complex options, such as AdGuard's custom element picker or 1Password's detailed security settings, are hidden from the primary interface and placed in secondary 'Advanced' screens or panels. This keeps the main UI clean and simple for most users while still providing power-user capabilities.

## Recommendation For Mcp

Claude Code MCP plugins should adopt this pattern by implementing a two-level configuration model. First, establish safe, least-privilege defaults for all settings, especially for sensitive capabilities like network access or file system writes (e.g., default to 'Ask' or 'Off'). Second, the user interface should practice progressive disclosure: surface the most common and simple toggles in the main configuration view, and place more granular, complex, or risky controls within a clearly marked 'Advanced' section. This prevents overwhelming new users while still empowering expert users. For permissions, plugins should mirror the 'Ask vs. Always Allow' model, providing clear explanations for each requested capability.


# Settings Versioning And Migration Strategy

## Strategy Component

Schema Versioning

## Description

Include a top-level version field, such as `schemaVersion: "1.0"` or `mcp_settings_version: "1.0"`, directly within the settings JSON file. When a new release introduces breaking changes to the settings structure, this version number is incremented. This allows the plugin to identify the configuration version it is dealing with and apply the correct parsing logic or trigger a migration process.

