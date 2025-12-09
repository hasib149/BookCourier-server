require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("BooksDB");
    const booksCollection = db.collection("books");
    const customerOrderCollection = db.collection("customer-order");
    const invoicesCoolection = db.collection("Invoices");
    // book added
    app.post("/books", async (req, res) => {
      const bookData = req.body;
      console.log(bookData);
      const result = await booksCollection.insertOne(bookData);
      res.send(result);
    });
    // get all books from db
    app.get("/books", async (req, res) => {
      const result = await booksCollection
        .find({ status: "published" })
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    });
    // get 5  books from db
    app.get("/books-limit", async (req, res) => {
      const result = await booksCollection
        .find()
        .sort({ _id: -1 })
        .limit(6)
        .toArray();
      res.send(result);
    });
    // get one plants
    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // order-data
    app.post("/customer-order", async (req, res) => {
      const orderData = req.body;
      console.log(orderData);
      orderData.order_status = "pending";
      orderData.payment_status = "unpaid";
      orderData.orderedAt = new Date().toDateString();
      const result = await customerOrderCollection.insertOne(orderData);
      res.send(result);
    });

    // my-order
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await customerOrderCollection
        .find({ email: req.tokenEmail })
        .sort({ orderedAt: -1 })
        .toArray();
      res.send(result);
    });

    // cancel-order
    app.patch("/cancel-order/:id", async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await customerOrderCollection.updateOne(
        { _id: id },
        { $set: { order_status: "cancelled" } }
      );
      res.send(result);
    });

    // payment cheakout system
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.bookname,
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          bookId: paymentInfo?.bookId,
          customer: paymentInfo?.customer.email,
          name: paymentInfo?.bookname,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/books/${paymentInfo?.bookId}`,
      });
      res.send({ url: session.url });
    });

    // payment-success
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res.send({ success: false, message: "Payment not completed" });
        }
        const bookId = session.metadata.bookId;
        const query = { _id: new ObjectId(bookId) };
        const update = { $set: { payment_status: "paid" } };
        await customerOrderCollection.updateOne(query, update);
        const exist = await invoicesCoolection.findOne({
          PaymentID: session.payment_intent,
        });
        if (!exist) {
          const orderInfo = {
            bookID: session.metadata.bookId,
            PaymentID: session.payment_intent,
            customer: session.metadata.customer,
            quantity: 1,
            date: new Date().toISOString(),
            Amount: session.amount_total / 100,
          };
          await invoicesCoolection.insertOne(orderInfo);
        }
        return res.send({ success: true });
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, error: "Server error" });
      }
    });

    // get-invoice-data
    app.get("/invoices/:email", async (req, res) => {
      const email = req.params.email;
      const result = await invoicesCoolection
        .find({ customer: email })
        .toArray();
      res.send(result);
    });
    // my-books liberian
    app.get("/my-books/:email", async (req, res) => {
      const email = req.params.email;
      const result = await booksCollection
        .find({ "Librarian.email": email })
        .toArray();
      res.send(result);
    });
    // my-books-status-update
    app.patch("/status-update/:id", async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await booksCollection.updateOne(
        { _id: id },
        { $set: { status: "unpublished" } }
      );
      res.send(result);
    });

    // get edited data for one products
    app.get("/editBooks/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // edit-book
    app.put("/book-edit/:id", async (req, res) => {
      const id = req.params.id;
      const updatedReview = req.body;
      const result = await booksCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedReview }
      );
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Shrabon..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
