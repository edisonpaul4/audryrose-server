const shippo = require('shippo')(process.env.SHIPPO_API_TOKEN);
const { CustomersController } = require('../customers/customers.controller');

exports.ShipmentsController = new class ShipmentsController {
  constructor() {
    this.baseAddress = {
      object_purpose: "PURCHASE",
      name: "Audry Rose",
      company: "",
      street1: "1515 7TH ST.",
      street2: "#433",
      city: "Santa Monica",
      state: "CA",
      zip: "90401",
      country: "US",
      phone: "+1 424 387 8000",
      email: "hello@loveaudryrose.com"
    }
  }

  getRatesForShipment(parcelParams, customerId) {
    if (!parcelParams || !customerId)
      throw new Error({ message: 'Information of parcel and customer\'s address is required.' });

    const parcel = {
      ...parcelParams,
      object_purpose: "QUOTE",
      distance_unit: "in",
      mass_unit: "oz",
    }

    const getCustomerAddress = customerId => {
      const prepareAddressObject = customerObject => ({
        name: customerObject.get('billingAddress').name,
        street1: customerObject.get('billingAddress').street_1,
        city: customerObject.get('billingAddress').city,
        state: customerObject.get('billingAddress').state,
        zip: customerObject.get('billingAddress').zip,
        country: customerObject.get('billingAddress').country_iso2,
        email: customerObject.get('billingAddress').email
      });

      return CustomersController.getCustomerById(customerId)
        .then(prepareAddressObject);
    };

    const createShipment = (addressTo, parcel, addressFrom) => {
      return shippo.shipment.create({
        "object_purpose": "QUOTE",
        "address_from": { ...addressFrom, object_purpose: "QUOTE" },
        "address_to": addressTo,
        "parcel": parcel,
        "async": false,
        "carrier_accounts": ["c67f85102205443e813814c72f2d48c6"]
      })
    }

    const minifyResponse = rates => rates.map(rate => ({
      carrier_account: rate.carrier_account,
      provider_image_200: rate.provider_image_200,
      provider: rate.provider,
      amount: rate.amount,
      currency: rate.currency,
      servicelevel_name: rate.servicelevel_name,
      days: rate.days,
      duration_terms: rate.duration_terms,
      attributes: rate.attributes,
    }));

    return getCustomerAddress(customerId)
      .then(customerAddress => createShipment(customerAddress, parcel, this.baseAddress))
      .then(shipmentObject => shippo.shipment.rates(shipmentObject.object_id))
      .then(response => minifyResponse(response.results));
  }
}