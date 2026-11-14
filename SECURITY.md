# Security

This initial development release has not been accepted for production use. A passing local test suite is not an external security audit.

Do not post credentials, personal data, exploit details, or financial records in public issues. If this GitHub repository has private vulnerability reporting enabled, use **Security → Report a vulnerability**. Otherwise, contact the repository owner privately through an established channel before sharing details. No monitored security email address is configured in this source tree.

Reports should identify the affected commit, impact, minimal reproduction in a disposable environment, and suggested remediation. Do not test against systems you do not own or have permission to assess.

Never commit environment files, authenticator secrets, database dumps, or raw operational evidence. Keep database identities separate and preserve PostgreSQL posting authority. Review the production gate before any hosted deployment.

The repository owner must enable private vulnerability reporting and assign a response owner before public publication.
