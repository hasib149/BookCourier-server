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
    const usersCollection = db.collection("users");
    const reviewsCollection = db.collection("review");
    const wishlistCollection = db.collection("wishlist");

    // book added
    app.post("/books", verifyJWT, async (req, res) => {
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
    app.post("/customer-order", verifyJWT, async (req, res) => {
      const orderData = req.body;
      console.log(orderData);
      orderData.order_status = "pending";
      orderData.payment_status = "unpaid";
      orderData.orderedAt = new Date();
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
    app.get("/invoices", verifyJWT, async (req, res) => {
      const result = await invoicesCoolection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // my-books liberian
    app.get("/my-books", verifyJWT, async (req, res) => {
      const result = await booksCollection
        .find({ "Librarian.email": req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // my-books-status-update
    app.patch("/status-update/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await booksCollection.updateOne(
        { _id: id },
        { $set: { status: "unpublished" } }
      );
      res.send(result);
    });

    // get edited data for one products
    app.get("/editBooks/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // edit-book
    app.put("/book-edit/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const updatedReview = req.body;
      const result = await booksCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedReview }
      );
      res.send(result);
    });

    // liberian all order data
    app.get("/allOrders", verifyJWT, async (req, res) => {
      const result = await customerOrderCollection
        .find({ "librarian.email": req.tokenEmail })
        .toArray();
      res.send(result);
    });

    //order calcel
    app.patch("/orders/cancel/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await customerOrderCollection.updateOne(
        { _id: id },
        { $set: { order_status: "cancelled" } }
      );
      res.send(result);
    });

    // order status cjhange
    app.put("/orders/status/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      const newStatus = req.body.status;
      const result = await customerOrderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { order_status: newStatus } }
      );
      res.send(result);
    });

    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a user role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // get all user
    app.get("/alluser", verifyJWT, async (req, res) => {
      const result = await usersCollection
        .find({ email: { $ne: req.tokenEmail } })
        .toArray();
      res.send(result);
    });

    // all books for admin
    app.get("/adminbooks", verifyJWT, async (req, res) => {
      const result = await booksCollection.find().sort({ _id: -1 }).toArray();
      res.send(result);
    });

    // make user update--->liberian
    app.patch("/userRole/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await usersCollection.updateOne(
        { _id: id },
        { $set: { role: "librarian" } }
      );
      res.send(result);
    });
    // make user update--->Admin
    app.patch("/userRoles/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await usersCollection.updateOne(
        { _id: id },
        { $set: { role: "admin" } }
      );
      res.send(result);
    });

    // admin publish
    app.patch("/userstatus/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await booksCollection.updateOne(
        { _id: id },
        { $set: { status: "published" } }
      );
      res.send(result);
    });
    // admin unpublish
    app.patch("/userstatusunpublish/:id", verifyJWT, async (req, res) => {
      const id = new ObjectId(req.params.id);
      const result = await booksCollection.updateOne(
        { _id: id },
        { $set: { status: "unpublished" } }
      );
      res.send(result);
    });

    // delete book and order
    app.delete("/booksupdate/:id", verifyJWT, async (req, res, next) => {
      const id = req.params.id;

      const deleteBook = await booksCollection.deleteOne({
        _id: new ObjectId(id),
      });

      const deleteOrders = await customerOrderCollection.deleteMany({
        productId: id,
      });

      res.send({
        success: true,
        message: "Book and related orders deleted",
        deleteBook,
        deleteOrders,
      });
    });

    // search
    app.get("/search", async (req, res) => {
      const search = req.query.search || "";
      const result = await booksCollection
        .find({ name: { $regex: search, $options: "i" } })
        .toArray();

      res.send(result);
    });

    // sort
    app.get("/sort", async (req, res) => {
      const sort = req.query.sort;
      const result = await booksCollection
        .find()
        .sort({ price: sort === "asc" ? 1 : -1 })
        .toArray();
      res.send(result);
    });

    // add review
    app.post("/reviews", async (req, res) => {
      const { bookId, userName, rating, review } = req.body;
      if (!bookId || !rating) {
        return res.status(400).send({ message: "Missing fields" });
      }
      const newReview = {
        bookId,
        userName,
        rating,
        review,
        createdAt: new Date(),
      };
      const result = await reviewsCollection.insertOne(newReview);
      res.send(result);
    });

    // get review
    app.get("/reviews/:bookId", async (req, res) => {
      const bookId = req.params.bookId;
      const reviews = await reviewsCollection.find({ bookId }).toArray();
      res.send(reviews);
    });

    // rating
    app.get("/rating/:bookId", async (req, res) => {
      const bookId = req.params.bookId;
      const reviews = await reviewsCollection.find({ bookId }).toArray();
      const avg =
        reviews.reduce((acc, r) => acc + r.rating, 0) / (reviews.length || 1);
      res.send({ averageRating: avg, totalReviews: reviews.length });
    });

    // wishlist---->post
    app.post("/api/wishlist", async (req, res) => {
      const {
        useremail,
        bookId,
        description,
        quantity,
        price,
        category,
        image,
        bookname,
        status,
        author,
      } = req.body;

      try {
        // Already exists check
        const exists = await wishlistCollection.findOne({ useremail, bookId });
        if (exists) {
          return res.status(400).json({ message: "Book already in wishlist" });
        }

        const wishlistItem = {
          useremail,
          bookId,
          description,
          quantity,
          price,
          category,
          image,
          bookname,
          status,
          author,
        };
        await wishlistCollection.insertOne(wishlistItem);

        res
          .status(200)
          .json({ message: "Book added to wishlist", wishlistItem });
      } catch (err) {
        console.error(err); // <-- log the actual error
        res.status(500).json({ error: err.message });
      }
    });
    // ---->whislist get
    app.get("/api/wishlist", verifyJWT, async (req, res) => {
      try {
        const wishlistItems = await wishlistCollection
          .find({ useremail: req.tokenEmail })
          .toArray();

        res.status(200).json(wishlistItems);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
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
