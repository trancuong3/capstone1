# BACKEND_FLOW_STANDARD

## Purpose

This document defines the standard Backend architecture for ReadAlong Vision. It is a reference standard, not proof that every existing API already follows it. Reviewers must trace actual imports and function calls rather than infer architecture from directory names.

## 1. Standard flow

~~~text
HTTP Request
  → Router
  → Request Schema / Path & Query Validation
  → Service
  → Repository
  → Model / ORM
  → PostgreSQL
  → Model Object
  → Repository
  → Service
  → Response Schema
  → Router
  → JSON Response
~~~

~~~mermaid
flowchart TD
    A[HTTP Request] --> B[Router]
    B --> C[Request Schema / Parameter Validation]
    C --> D[Service]
    D --> E[Repository]
    E --> F[Model / ORM]
    F --> G[(PostgreSQL)]
    G --> H[Model Object]
    H --> E
    E --> D
    D --> I[Response Schema]
    I --> B
    B --> J[JSON Response]
~~~

## 2. Layer responsibilities

| Layer | Responsibility | Must not |
| --- | --- | --- |
| Router | Define endpoints, accept validated input, call Service, select HTTP status and response model | Query the database, write SQL or contain business rules |
| Request Schema | Validate types, required fields, formats, limits and input rules | Query the database or execute business logic |
| Service | Business logic, business authorization, coordinate repositories and decide the action | Write SQL or query AsyncSession directly |
| Repository | Query, CRUD, joins, pagination, sorting and database persistence through Model/ORM | Decide business rules or process HTTP |
| Model / ORM | Map entities to database tables, columns, keys and relationships | Contain HTTP logic or the API workflow |
| PostgreSQL | Store and query persistent data | Execute HTTP handling or application business logic |
| Response Schema | Define public output fields and validate response data | Expose unrestricted ORM data or private fields |

Path and query parameters may be validated by FastAPI parameters; a Pydantic body schema is not required for every input. Response schemas must exclude passwords, hashes, tokens, credentials, private metadata and fields not intended for clients.

## 3. Flows by request type

### GET

~~~text
Client → Router → Parameter Validation → Service → Repository
       → Model / ORM → PostgreSQL → ORM Object → Repository
       → Service → Response Schema → Router → JSON
~~~

### POST / CREATE

~~~text
Client → Router → Request Schema → Service → Repository
       → Model / ORM → PostgreSQL → Created ORM Object
       → Repository → Service → Response Schema → Router → JSON
~~~

### PUT / PATCH / UPDATE

~~~text
Client → Router → Request Schema → Service → Repository
       → Load Existing Object → PostgreSQL
       → Service Applies Business Rules → Repository Persists Update
       → PostgreSQL → Updated Object → Service → Response Schema → Router → JSON
~~~

### DELETE / RETIRE

The Service decides whether the business operation requires hard delete or soft delete. The Repository performs the database operation. Preserve history whenever project rules require it.

### Error flow

~~~text
Schema Validation Error → FastAPI validation response
Business Error → Service exception → Router / registered exception handler → HTTP error
Database Error → Repository / transaction boundary → rollback and safe propagation
~~~

HTTP status codes must follow existing API contracts. Do not assume a new status code without checking the current contract.

## 4. Mock flow vs real database flow

~~~text
MOCK FLOW:
Router → Mock Service → Fixture Data → Response Schema → JSON

REAL DATABASE FLOW:
Router → Request Schema → Service → Repository → Model / ORM
       → PostgreSQL → ORM Object → Repository → Service
       → Response Schema → JSON
~~~

Mock data is allowed only for tests, isolated development fixtures or explicitly identified demos. Never describe a mock response as PostgreSQL data. Do not delete mocks before checking callers and tests, and never introduce a mock to hide a broken production integration.

## 5. Mandatory API tracing

For each API being reviewed:

1. Identify the actual Router, HTTP method, endpoint, dependencies and parameter validation.
2. Trace the exact Service function called.
3. Trace each Repository call and each query/ORM operation.
4. Identify the exact Model and PostgreSQL table or tables.
5. Trace returned ORM objects through Repository → Service → Response Schema → Router.
6. Record authorization, error handling, transaction and external-service paths.
7. Clearly label any mock or external-service path.
8. Use the real file, class, function, endpoint and table names found in source.
9. If a layer cannot be confirmed from the provided source, explicitly say it cannot be identified; do not invent it.
10. If actual code differs from this standard, document the Actual Flow and differences before refactoring.

## 6. Required review format

~~~text
API:
HTTP method + endpoint

1. Router: file and function
2. Request Schema / path / query validation: file, type and rules
3. Service: file, class/function, business logic and authorization
4. Repository: file, class/function, queries and persistence
5. Model / ORM: file and class
6. PostgreSQL: actual table or tables
7. Response Schema: file, type and exposed fields
8. Error / transaction flow
9. Mock or external-service dependencies

STANDARD FLOW:
Router → Schema → Service → Repository → Model/ORM → PostgreSQL
       → ORM Object → Repository → Service → Response Schema → JSON

ACTUAL FLOW:
Describe the exact function calls found in source.

COMPARISON:
List missing, bypassed or misplaced layers using source-code evidence.
~~~

## 7. Golden rule

~~~text
Router        → HTTP
Schema        → Validation and output contract
Service       → Business logic and business authorization
Repository    → Database access and persistence
Model / ORM   → Database entity mapping
PostgreSQL    → Persistent data
~~~

A folder existing does not prove that an API uses that layer. Follow real imports and calls. Change architecture only when requested, preserve API behavior, and add or update tests when refactoring a flow.
