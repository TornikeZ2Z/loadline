# loadline's OWN deploy role. The ziptozip prod stack's github_deploy role
# pins its `sub` to the ziptozip repository, and that condition IS the
# security boundary — widening it to admit a second repository would be the
# wrong instinct. Because the OIDC provider is merely read (platform.tf),
# this role lives entirely in loadline's state and prod is never applied.
data "aws_iam_policy_document" "deploy_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The trust boundary. Only workflows in this repository, running on
    # main, may assume it. workflow_dispatch on main still works — a
    # manually-triggered run's token still carries ref:refs/heads/main.
    # workflow_dispatch from a side branch deliberately stops working: the
    # workflow force-deploys :latest regardless of ref, so dispatching from
    # a branch would silently deploy main's image under that branch's name.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # BOTH forms are listed on purpose. GitHub is transitioning OIDC subjects
      # from `repo:OWNER/REPO:...` to the id-qualified
      # `repo:OWNER@<id>/REPO@<id>:...`, and this repository already sends the
      # latter — matching only the plain form fails with the maddeningly generic
      # "Not authorized to perform sts:AssumeRoleWithWebIdentity", which AWS
      # returns for BOTH a trust mismatch and a nonexistent role, so it does not
      # tell you which. Listing both keeps the role working whichever is sent.
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo_qualified}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_assume_role.json
}

data "aws_iam_policy_document" "deploy" {
  # GetAuthorizationToken cannot be scoped to a repository — it is an
  # account-level call that returns a registry login token.
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushToLoadlineRepoOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid = "EcsDeployLoadlineServiceOnly"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [aws_ecs_service.app.id]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.name_prefix}-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
