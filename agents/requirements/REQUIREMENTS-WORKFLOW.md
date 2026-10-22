# Requirements-Driven Workflow Guide

> Lightweight alternative to BMAD for rapid prototyping and simple feature development

## 🎯 What is Requirements Workflow?

A streamlined 4-phase workflow that focuses on getting from requirements to working code quickly:

**Requirements → Implementation → Review → Testing**

Perfect for:
- Quick prototypes
- Small features
- Bug fixes with clear scope
- Projects without complex architecture needs

## 🚀 Quick Start

### Basic Command

```bash
/requirements-pilot "Implement JWT authentication with refresh tokens"

# Automated workflow:
# 1. Requirements generation (90% quality gate)
# 2. Code implementation
# 3. Code review
# 4. Testing strategy
```

### When to Use

**Use Requirements Workflow** when:
- Feature scope is clear and simple
- No complex architecture design needed
- Fast iteration is priority
- You want minimal workflow overhead

**Use BMAD Workflow** when:
- Complex business requirements
- Multiple systems integration
- Architecture design is critical
- Need detailed sprint planning

## 📋 Workflow Phases

### Phase 1: Requirements Generation
- **Agent**: `requirements-generate`
- **Quality Gate**: Requirements score ≥ 90/100
- **Output**: Functional requirements document
- **Focus**:
  - Clear functional requirements
  - Acceptance criteria
  - Technical constraints
  - Implementation notes

**Quality Criteria (100 points)**:
- Clarity (30): Unambiguous, well-defined
- Completeness (25): All aspects covered
- Testability (20): Clear verification points
- Technical Feasibility (15): Realistic implementation
- Scope Definition (10): Clear boundaries

### Phase 2: Code Implementation
- **Agent**: `requirements-code`
- **Quality Gate**: Code completion
- **Output**: Implementation files
- **Process**:
  1. Read requirements + repository context
  2. Implement features following requirements
  3. Create or modify code files
  4. Follow existing code conventions

### Phase 3: Code Review
- **Agent**: `requirements-review`
- **Quality Gate**: Pass / Pass with Risk / Fail
- **Output**: Review report
- **Focus**:
  - Code quality
  - Requirements alignment
  - Security concerns
  - Performance issues
  - Best practices compliance

**Review Status**:
- **Pass**: Meets standards, ready for testing
- **Pass with Risk**: Minor issues noted
- **Fail**: Requires implementation revision

### Phase 4: Testing Strategy
- **Agent**: `requirements-testing`
- **Quality Gate**: Test execution
- **Output**: Test report
- **Process**:
  1. Create test strategy from requirements
  2. Generate test cases
  3. Execute tests (unit, integration)
  4. Report results

## 📁 Workflow Artifacts

Generated in `.claude/requirements/{feature-name}/`:

```
.claude/requirements/jwt-authentication/
├── 01-requirements.md        # Functional requirements (score ≥ 90)
├── 02-implementation.md      # Implementation summary
├── 03-review.md             # Code review report
└── 04-testing.md            # Test strategy and results
```

## 🔧 Command Options

```bash
# Standard workflow
/requirements-pilot "Add API rate limiting"

# With specific technology
/requirements-pilot "Redis caching layer with TTL management"

# Bug fix with requirements
/requirements-pilot "Fix login session timeout issue"
```

## 📊 Quality Scoring

### Requirements Score (100 points)

| Category | Points | Description |
|----------|--------|-------------|
| Clarity | 30 | Unambiguous, well-defined requirements |
| Completeness | 25 | All functional aspects covered |
| Testability | 20 | Clear acceptance criteria |
| Technical Feasibility | 15 | Realistic implementation plan |
| Scope Definition | 10 | Clear feature boundaries |

**Threshold**: ≥ 90 points to proceed

### Automatic Optimization

If initial score < 90:
1. User provides feedback
2. Agent revises requirements
3. System recalculates score
4. Repeat until ≥ 90
5. User confirms → Save → Next phase

## 🎯 Comparison: Requirements vs BMAD

| Aspect | Requirements Workflow | BMAD Workflow |
|--------|----------------------|---------------|
| **Phases** | 4 (Requirements → Code → Review → Test) | 6 (PO → Arch → SM → Dev → Review → QA) |
| **Duration** | Fast (hours) | Thorough (days) |
| **Documentation** | Minimal | Comprehensive |
| **Quality Gates** | 1 (Requirements ≥ 90) | 2 (PRD ≥ 90, Design ≥ 90) |
| **Approval Points** | None | Multiple (after PRD, Architecture, Sprint Plan) |
| **Best For** | Simple features, prototypes | Complex features, enterprise projects |
| **Artifacts** | 4 documents | 6 documents |
| **Planning** | Direct implementation | Sprint planning included |
| **Architecture** | Implicit in requirements | Explicit design phase |

## 💡 Usage Examples

### Example 1: API Feature

```bash
/requirements-pilot "REST API endpoint for user profile updates with validation"

# Generated requirements include:
# - Endpoint specification (PUT /api/users/:id/profile)
# - Request/response schemas
# - Validation rules
# - Error handling
# - Authentication requirements

# Implementation follows directly
# Review checks API best practices
# Testing includes endpoint testing
```

### Example 2: Database Schema

```bash
/requirements-pilot "Add audit logging table for user actions"

# Generated requirements include:
# - Table schema definition
# - Indexing strategy
# - Retention policy
# - Query patterns

# Implementation creates migration
# Review checks schema design
# Testing verifies logging behavior
```

### Example 3: Bug Fix

```bash
/requirements-pilot "Fix race condition in order processing queue"

# Generated requirements include:
# - Problem description
# - Root cause analysis
# - Solution approach
# - Verification steps

# Implementation applies fix
# Review checks concurrency handling
# Testing includes stress tests
```

## 🔄 Iterative Refinement

Each phase supports feedback:

```
Agent: "Requirements complete (Score: 85/100)"
User: "Add error handling for network failures"
Agent: "Updated requirements (Score: 93/100) ✅"
```

## 🚀 Advanced Usage

### Combining with Individual Commands

```bash
# Generate requirements only
/requirements-generate "OAuth2 integration requirements"

# Just code implementation (requires existing requirements)
/requirements-code "Implement based on requirements.md"

# Standalone review
/requirements-review "Review current implementation"
```

### Integration with BMAD

Use Requirements Workflow for sub-tasks within BMAD sprints:

```bash
# BMAD creates sprint plan
/bmad-pilot "E-commerce platform"

# Use Requirements for individual sprint tasks
/requirements-pilot "Shopping cart session management"
/requirements-pilot "Payment webhook handling"
```

## 📚 Related Documentation

- **[BMAD Workflow](../bmad/BMAD-WORKFLOW.md)** - Full agile methodology
- **[Development Commands](../development-essentials/DEVELOPMENT-COMMANDS.md)** - Direct coding commands
- **[Quick Start Guide](../../README.md#quick-start)** - Get started quickly

---

**Requirements-Driven Development** - From requirements to working code in hours, not days.
