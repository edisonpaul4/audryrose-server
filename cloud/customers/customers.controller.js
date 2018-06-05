var { CustomersModel } = require('./customers.model');
var { OrdersModel } = require('../orders/orders.model');
var Customer = Parse.Object.extend('Customer');
const Mailgun = require('mailgun-js');
const mailgun = new Mailgun({ apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN });

exports.CustomersController = new class CustomersController {
  constructor() { }

  /**
   * 
   * @returns {Promise} <ParseObject<Customer>>
   * @param {Number} customerId
   * @param {Boolean} json
   */
  getCustomerById(customerId, json = false) {
    console.log('CustomersModel::getCustomerById');
    return CustomersModel.getCustomersByFilters({
      equal: [{ key: 'customerId', value: customerId }]
    }).first().then(object => json ? object.toJSON() : object);
  } // END fixClearedVendorOrdersResults

  sendOrderEmail(orderId, emailParams) {
    console.log('OrdersController::sendOrderEmail');
    const getOrder = orderId => OrdersModel.getOrdersByFilters({
      includes: ['customer'],
      equal: [
        { key: 'orderId', value: orderId }
      ]
    }).first();

    const updatedIsEmailSended = orderObject => {
      var query = new Parse.Query(Customer)
      query.equalTo('customerId', orderObject.get('customer_id'))
      return query.first().then(customer => {
        return customer.set('isFollowUpEmailSended', true).save();
      })
    }

    const sendEmailToCustomer = (order, emailParams) => {
      const data = {
        from: 'tracy@loveaudryrose.com',
        to: `${order.get('customer').get('firstName') + ' ' + order.get('customer').get('lastName')} <${process.env.NODE_ENV === 'production' ? order.get('billing_address').email : 'ejas94@gmail.com'}>`,
        cc: process.env.NODE_ENV === 'production' ? 'Audry Rose <tracy@loveaudryrose.com>' : 'Testing <arrieta.e@outlook.com>',
        subject: emailParams.emailSubject,
        text: emailParams.emailMessage,
      }
      return mailgun.messages().send(data)
        .then(emailResult => ({
          emailResult,
          order
        }));
    }

    return getOrder(orderId)
      .then(order => sendEmailToCustomer(order, emailParams))
      .then(results => updatedIsEmailSended(results.order))
      .then(customer => ({
        success: true,
        orderId
      }));
  }
}