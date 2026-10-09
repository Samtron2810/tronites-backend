import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import Like from "../models/Like.js";
import CommentLike from "../models/CommentLike.js";
import Bookmark from "../models/Bookmark.js";
import Follow from "../models/Follow.js";
import Block from "../models/Block.js";
import Mute from "../models/Mute.js";
import Message from "../models/Message.js";
import Notification from "../models/Notification.js";
import Report from "../models/Report.js";
import User from "../models/User.js";
import SavedSearch from "../models/SavedSearch.js";
import Appeal from "../models/Appeal.js";
import AdCampaign from "../models/AdCampaign.js";
import CreatorTip from "../models/CreatorTip.js";
import VerificationPayment from "../models/VerificationPayment.js";
import VerificationRequest from "../models/VerificationRequest.js";
import Session from "../models/Session.js";
import { CreatorBankAccount, CreatorPayout } from "../models/CreatorPayout.js";
import { CreatorPlan, CreatorSubscription } from "../models/CreatorSubscription.js";
import { toPrivateSelfDTO } from "../dtos/userDTO.js";

// Everything this endpoint returns is data the requesting user already
// has some claim to — their own account fields, their own posts/
// comments/messages, the *fact* of their own social edges, and their own
// payment, verification and consent records (NDPA access right: everything
// we hold about the person). It does NOT include other users' private data
// merely because an edge references them (e.g. a message thread only
// includes the other participant's id, not their profile details) — this
// is a "your data" export, not a scrape of everyone you've ever
// interacted with.
//
// Deliberately excluded because they are credentials/secrets rather than
// personal data: password hash, refresh-token hashes, Paystack
// authorization codes and recipient codes, push-subscription keys.
export const buildUserDataExport = async (user) => {
  const userId = user._id;

  const [
    posts,
    comments,
    likes,
    commentLikes,
    bookmarks,
    following,
    followers,
    blocking,
    muting,
    sentMessages,
    receivedMessages,
    notifications,
    reportsFiled,
    savedSearches,
    appeals,
    campaigns,
    tipsSent,
    tipsReceived,
    verificationPayments,
    verificationRequests,
    sessions,
    bankAccounts,
    payouts,
    plans,
    subscriptionsAsSubscriber,
    subscriptionsAsCreator,
    sensitive,
  ] = await Promise.all([
    Post.find({ user: userId }).select("-__v").lean(),
    Comment.find({ user: userId }).select("-__v").lean(),
    Like.find({ user: userId }).select("post createdAt").lean(),
    CommentLike.find({ user: userId }).select("comment createdAt").lean(),
    Bookmark.find({ user: userId }).select("post createdAt").lean(),
    Follow.find({ follower: userId }).select("following createdAt").lean(),
    Follow.find({ following: userId }).select("follower createdAt").lean(),
    Block.find({ blocker: userId }).select("blocked createdAt").lean(),
    Mute.find({ muter: userId }).select("muted createdAt").lean(),
    Message.find({ sender: userId }).select("-__v").lean(),
    Message.find({ receiver: userId }).select("-__v").lean(),
    Notification.find({ recipient: userId }).select("-__v").lean(),
    Report.find({ reporter: userId }).select("-__v").lean(),
    SavedSearch.find({ user: userId }).select("-__v").lean(),
    Appeal.find({ user: userId }).select("-__v").lean(),
    AdCampaign.find({ user: userId }).select("-__v").lean(),
    CreatorTip.find({ sender: userId }).select("-__v").lean(),
    CreatorTip.find({ creator: userId }).select("-__v").lean(),
    VerificationPayment.find({ user: userId }).select("-__v").lean(),
    VerificationRequest.find({ user: userId }).select("-__v").lean(),
    Session.find({ user: userId }).select("userAgent ip lastUsedAt createdAt expiresAt").lean(),
    CreatorBankAccount.find({ creator: userId })
      .select("bankName accountName accountNumberLast4 bankCode createdAt")
      .lean(),
    CreatorPayout.find({ creator: userId }).select("-__v -paystackTransferCode").lean(),
    CreatorPlan.find({ creator: userId }).select("-__v").lean(),
    CreatorSubscription.find({ subscriber: userId })
      .select("-__v -paystackAuthCode -paystackCustomerCode")
      .lean(),
    CreatorSubscription.find({ creator: userId })
      .select("-__v -paystackAuthCode -paystackCustomerCode -subscriberEmail")
      .lean(),
    // select:false fields (date of birth, consent record) are not on
    // req.user, so fetch them explicitly.
    User.findById(userId)
      .select("+dateOfBirth +termsAcceptedAt +termsVersion")
      .lean(),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    account: {
      ...toPrivateSelfDTO(user),
      dateOfBirth: sensitive?.dateOfBirth || null,
      marketingEmails: user.marketingEmailOptOut !== true,
      marketingEmailsSetAt: user.marketingEmailsSetAt || null,
    },
    consent: {
      termsAcceptedAt: sensitive?.termsAcceptedAt || null,
      termsVersion: sensitive?.termsVersion || null,
    },
    posts,
    comments,
    likes: {
      posts: likes,
      comments: commentLikes,
    },
    bookmarks,
    social: {
      // IDs only — resolving these to full profiles would mean handing
      // back other users' data as a side effect of exporting your own,
      // which is out of scope for this endpoint (see module comment).
      following: following.map((f) => ({ userId: f.following, since: f.createdAt })),
      followers: followers.map((f) => ({ userId: f.follower, since: f.createdAt })),
      blocking: blocking.map((b) => ({ userId: b.blocked, since: b.createdAt })),
      muting: muting.map((m) => ({ userId: m.muted, since: m.createdAt })),
    },
    messages: {
      sent: sentMessages,
      received: receivedMessages,
    },
    notifications,
    reportsFiled,
    savedSearches,
    appeals,
    activeSessions: sessions,
    verification: {
      applications: verificationRequests,
      payments: verificationPayments,
    },
    payments: {
      promotionCampaigns: campaigns,
      tipsSent,
      tipsReceived,
      subscriptionsAsSubscriber,
      subscriptionsAsCreator,
      subscriptionPlans: plans,
      payoutBankAccounts: bankAccounts,
      payouts,
    },
  };
};
