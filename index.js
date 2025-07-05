const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
// Load environment variables from .env file
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(cors());
app.use(express.json());

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.swu9d.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.w9w0yyn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB"); // database name
    const usersCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    // custom middleware
    const verifyFBToken = async (req, res, next) => {
      console.log("middle in token", req.headers);
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorize access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorize access" });
      }

      // verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    const adminVerify = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // GET: Search users by email (case-insensitive, partial match)
    app.get("/users/search", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res.status(400).send({ error: "Email query is required" });
      }

      try {
        const users = await usersCollection
          .find({
            email: { $regex: email, $options: "i" }, // case-insensitive search
          })
          .project({ email: 1, role: 1, created_at: 1 }) // only needed fields
          .limit(10)
          .toArray();

        res.send(users);
      } catch (err) {
        console.error("User search failed:", err);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // PATCH: Update user role by email
    // GET: Get user role by email (check if admin)
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).send({ error: "Email is required" });
      }

      try {
        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } }
        );

        if (!user) {
          return res.status(404).send({ error: "User not found" });
        }

        // Send back the role, default to 'user' if undefined
        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ error: "Failed to fetch user role" });
      }
    });

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res.status(200).send({ message: "User already exists" });
      }
      const user = {
        ...req.body,
        created_at: new Date(),
      };
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // PATCH: Update user role (admin or user)
    app.patch("/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      if (!["admin", "user"].includes(role)) {
        return res.status(400).send({ error: "Invalid role" });
      }

      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );

        res.send(result);
      } catch (err) {
        console.error("Role update failed:", err);
        res.status(500).send({ error: "Could not update user role" });
      }
    });

    // parcels api
    // GET: All parcels OR parcels by user (created_by), sorted by latest
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { payment_status, delivery_status } = req.query;
        const query = {};

        if (payment_status) query.payment_status = payment_status;
        if (delivery_status) query.delivery_status = delivery_status;
        const options = {
          sort: { createdAt: -1 }, // Newest first
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // GET: Get a specific parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
      }
    });

    // POST: Create a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        // newParcel.createdAt = new Date();
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // riders related api
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders/pending", verifyFBToken, adminVerify, async (req, res) => {
      try {
        const pendingRiders = await db
          .collection("riders")
          .find({ status: "pending" })
          .sort({ applied_at: -1 }) // newest first
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to load pending riders:", error);
        res.status(500).send({ message: "Failed to fetch pending riders" });
      }
    });

    // PATCH: Update rider status (e.g., pending → active)
    app.patch("/riders/status/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: status,
              updated_at: new Date(),
            },
          }
        );

        if (result.modifiedCount > 0) {
          res.send({ success: true, message: "Status updated" });
        } else {
          res.status(404).send({
            success: false,
            message: "Rider not found or already updated",
          });
        }
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // GET: Active riders
    app.get("/riders/active", verifyFBToken, adminVerify, async (req, res) => {
      const result = await ridersCollection
        .find({ status: "active" })
        .toArray();
      res.send(result);
    });

    // approve user to rider
    app.patch(
      "/riders/:id/status",
      verifyFBToken,
      adminVerify,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;

        if (!["active", "rejected"].includes(status)) {
          return res.status(400).send({ error: "Invalid status value" });
        }

        try {
          const filter = { _id: new ObjectId(id) };
          const updateDoc = {
            $set: { status },
          };

          const result = await ridersCollection.updateOne(filter, updateDoc);

          // Update user role if approved
          if (status === "active") {
            const rider = await ridersCollection.findOne(filter);
            if (rider?.email) {
              await usersCollection.updateOne(
                { email: rider.email },
                { $set: { role: "rider" } }
              );
            }
          }

          res.send(result);
        } catch (error) {
          console.error("Error updating status:", error);
          res.status(500).send({ error: "Failed to update rider status" });
        }
      }
    );

    // GET: Riders by district
    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;
      if (!district)
        return res.status(400).send({ error: "District required" });

      try {
        const riders = await ridersCollection.find({ district }).toArray();
        res.send(riders);
      } catch (err) {
        res.status(500).send({ error: "Failed to load riders" });
      }
    });

    // POST: Assign rider to a parcel and update statuses
    app.post("/parcels/assign", async (req, res) => {
      const { parcelId, riderEmail, assignedAt } = req.body;

      if (!parcelId || !riderEmail) {
        return res
          .status(400)
          .send({ error: "parcelId and riderEmail are required" });
      }

      try {
        const parcelUpdateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "in_transit",
              assigned_rider: riderEmail,
              assigned_at: assignedAt || new Date(),
            },
          }
        );

        const riderUpdateResult = await ridersCollection.updateOne(
          { email: riderEmail },
          {
            $set: {
              work_status: "in_delivery",
              current_parcel: new ObjectId(parcelId),
            },
          }
        );

        res.send({
          success: true,
          message: "Rider assigned and statuses updated",
          parcelModified: parcelUpdateResult.modifiedCount,
          riderModified: riderUpdateResult.modifiedCount,
        });
      } catch (error) {
        console.error("Failed to assign rider:", error);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // DELETE: Reject (delete) a rider application by ID
    app.delete("/riders/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const result = await ridersCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount > 0) {
          res.send({
            success: true,
            message: "Rider application rejected and deleted.",
          });
        } else {
          res.status(404).send({ success: false, message: "Rider not found." });
        }
      } catch (error) {
        console.error("Error rejecting rider:", error);
        res.status(500).send({
          success: false,
          message: "Server error while rejecting rider.",
        });
      }
    });

    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;

      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        time: new Date(),
        updated_by,
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } }; // Latest first

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    // POST: Record payment and update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        // 1. Update parcel's payment_status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        // 2. Insert payment record
        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment processing failed:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // Amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Sample route
app.get("/", (req, res) => {
  res.send("Parcel Server is running");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
